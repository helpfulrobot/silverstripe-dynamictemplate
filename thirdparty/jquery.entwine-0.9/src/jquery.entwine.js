var console;

(function($) {	
	
	var namespaces = {};

	$.entwine = function() {
		$.fn.entwine.apply(null, arguments);
	};
	
	/**
	 * A couple of utility functions for accessing the store outside of this closure, and for making things
	 * operate in a little more easy-to-test manner
	 */
	$.extend($.entwine, {
		/**
		 * Get all the namespaces. Useful for introspection? Internal interface of Namespace not guaranteed consistant
		 */
		namespaces: namespaces,
		
		/**
		 * Remove all entwine rules
		 */
		clear_all_rules: function() { 
			// Remove proxy functions
			for (var k in $.fn) { if ($.fn[k].entwine) delete $.fn[k] ; }
			// Remove bound events - TODO: Make this pluggable, so this code can be moved to jquery.entwine.events.js
			$(document).unbind('.entwine');
			// Remove namespaces, and start over again
			namespaces = $.entwine.namespaces = {};
		},
		
		WARN_LEVEL_NONE: 0,
		WARN_LEVEL_IMPORTANT: 1,
		WARN_LEVEL_BESTPRACTISE: 2,
		
		/** 
		 * Warning level. Set to a higher level to get warnings dumped to console.
		 */
		warningLevel: 0,
		
		/** Utility to optionally display warning messages depending on level */
		warn: function(message, level) {
			if (level <= $.entwine.warningLevel && console && console.warn) { 
				console.warn(message);
				if (console.trace) console.trace();
			}
		},
		
		warn_exception: function(where, /* optional: */ on, e) {
			if ($.entwine.WARN_LEVEL_IMPORTANT <= $.entwine.warningLevel && console && console.warn) {
				if (arguments.length == 2) { e = on; on = null; }
				
				if (on) console.warn('Uncaught exception',e,'in',where,'on',on);
				else    console.warn('Uncaught exception',e,'in',where);
				
				if (e.stack) console.warn("Stack Trace:\n" + e.stack);
			}
		}
	});
	

	/** Stores a count of definitions, so that we can sort identical selectors by definition order */
	var rulecount = 0;
	
	var Rule = Base.extend({
		init: function(selector, name) {
			this.selector = selector;
			this.specifity = selector.specifity();
			this.important = 0;
			this.name = name;
			this.rulecount = rulecount++;
		}
	});
	
	Rule.compare = function(a, b) {
		var as = a.specifity, bs = b.specifity;
		
		return (a.important - b.important) ||
		       (as[0] - bs[0]) ||
		       (as[1] - bs[1]) ||
		       (as[2] - bs[2]) ||
		       (a.rulecount - b.rulecount) ;
	};

	$.entwine.RuleList = function() {
		var list = [];
		
		list.addRule = function(selector, name){ 
			var rule = Rule(selector, name);
			
			list[list.length] = rule; 
			list.sort(Rule.compare); 
			
			return rule;
		};
		
		return list;
	};

	var handlers = [];
	
	/**
	 * A Namespace holds all the information needed for adding entwine methods to a namespace (including the _null_ namespace)
	 */
	$.entwine.Namespace = Base.extend({
		init: function(name){
			if (name && !name.match(/^[A-Za-z0-9.]+$/)) $.entwine.warn('Entwine namespace '+name+' is not formatted as period seperated identifiers', $.entwine.WARN_LEVEL_BESTPRACTISE);
			name = name || '__base';
			
			this.name = name;
			this.store = {};
			
			namespaces[name] = this;
			
			if (name == "__base") {
				this.injectee = $.fn;
				this.$ = $;
			}
			else {
				// We're in a namespace, so we build a Class that subclasses the jQuery Object Class to inject namespace functions into
				var subfn = function(){};
				this.injectee = subfn.prototype = new $();
				
				// And then we provide an overriding $ that returns objects of our new Class, and an overriding pushStack to catch further selection building
				var bound$ = this.$ = function(a) {
					// Try the simple way first
					var jq = $.fn.init.apply(new subfn(), arguments);
					if (jq instanceof subfn) return jq;
					
					// That didn't return a bound object, so now we need to copy it
					var rv = new subfn();
					rv.selector = jq.selector; rv.context = jq.context; var i = rv.length = jq.length;
					while (i--) rv[i] = jq[i];
					return rv;
				};
				this.injectee.pushStack = function(elems, name, selector){
					var ret = bound$(elems);

					// Add the old object onto the stack (as a reference)
					ret.prevObject = this;
					ret.context = this.context;
					
					if ( name === "find" ) ret.selector = this.selector + (this.selector ? " " : "") + selector;
					else if ( name )       ret.selector = this.selector + "." + name + "(" + selector + ")";
					
					// Return the newly-formed element set
					return ret;
				};
				
				// Copy static functions through from $ to this.$ so e.g. $.ajax still works
				// @bug, @cantfix: Any class functions added to $ after this call won't get mirrored through 
				$.extend(this.$, $);
				
				// We override entwine to inject the name of this namespace when defining blocks inside this namespace
				var entwine_wrapper = this.injectee.entwine = function(spacename) {
					var args = arguments;
					
					if (!spacename || typeof spacename != 'string') { args = $.makeArray(args); args.unshift(name); }
					else if (spacename.charAt(0) != '.') args[0] = name+'.'+spacename;
					
					return $.fn.entwine.apply(this, args);
				};
				
				this.$.entwine = function() {
					entwine_wrapper.apply(null, arguments);
				};
				
				for (var i = 0; i < handlers.length; i++) {
					var handler = handlers[i], builder;
					
					// Inject jQuery object method overrides
					if (builder = handler.namespaceMethodOverrides) {
						var overrides = builder(this);
						for (var k in overrides) this.injectee[k] = overrides[k];
					}
					
					// Inject $.entwine function overrides
					if (builder = handler.namespaceStaticOverrides) {
						var overrides = builder(this);
						for (var k in overrides) this.$.entwine[k] = overrides[k];
					}
				}
			}
		},
		
		/**
		 * Returns a function that does selector matching against the function list for a function name
		 * Used by proxy for all calls, and by ctorProxy to handle _super calls
		 * @param {String} name - name of the function as passed in the construction object
		 * @param {String} funcprop - the property on the Rule object that gives the actual function to call
		 * @param {function} basefunc - the non-entwine function to use as the catch-all function at the bottom of the stack
		 */
		one: function(name, funcprop, basefunc) {
			var namespace = this;
			var funcs = this.store[name];
			
			var one = function(el, args, i){
				if (i === undefined) i = funcs.length;
				while (i--) {
					if (funcs[i].selector.matches(el)) {
						var ret, tmp_i = el.i, tmp_f = el.f;
						el.i = i; el.f = one;
						try { ret = funcs[i][funcprop].apply(namespace.$(el), args); }
						finally { el.i = tmp_i; el.f = tmp_f; }
						return ret;
					}
				}
				// If we didn't find a entwine-defined function, but there is a non-entwine function to use as a base, try that
				if (basefunc) return basefunc.apply(namespace.$(el), args);
			};
			
			return one;
		},
		
		/**
		 * A proxy is a function attached to a callable object (either the base jQuery.fn or a subspace object) which handles
		 * finding and calling the correct function for each member of the current jQuery context
		 * @param {String} name - name of the function as passed in the construction object
		 * @param {function} basefunc - the non-entwine function to use as the catch-all function at the bottom of the stack
		 */
		build_proxy: function(name, basefunc) {
			var one = this.one(name, 'func', basefunc);
			
			var prxy = function() {
				var rv, ctx = $(this); 
				
				var i = ctx.length;
				while (i--) rv = one(ctx[i], arguments);
				return rv;
			};
			
			return prxy;
		},
		
		bind_proxy: function(selector, name, func) {
			var rulelist = this.store[name] || (this.store[name] = $.entwine.RuleList());
			
			var rule = rulelist.addRule(selector, name); rule.func = func;
			
			if (!this.injectee.hasOwnProperty(name) || !this.injectee[name].entwine) {
				this.injectee[name] = this.build_proxy(name, this.injectee.hasOwnProperty(name) ? this.injectee[name] : null);
				this.injectee[name].entwine = true;
			}

			if (!this.injectee[name].entwine) {
				$.entwine.warn('Warning: Entwine function '+name+' clashes with regular jQuery function - entwine function will not be callable directly on jQuery object', $.entwine.WARN_LEVEL_IMPORTANT);
			}
		},
		
		add: function(selector, data) {
			// For every item in the hash, try ever method handler, until one returns true
			for (var k in data) {
				var v = data[k];
				
				for (var i = 0; i < handlers.length; i++) {
					if (handlers[i].bind && handlers[i].bind.call(this, selector, k, v)) break;
				}
			}
		},
		
		has: function(ctx, name) {
			var rulelist = this.store[name];
			if (!rulelist) return false;
			
			/* We go forward this time, since low specifity is likely to knock out a bunch of elements quickly */
			for (var i = 0 ; i < rulelist.length; i++) {
				ctx = ctx.not(rulelist[i].selector);
				if (!ctx.length) return true;
			}
			return false;
		}
	});
	
	/**
	 * A handler is some javascript code that adds support for some time of key / value pair passed in the hash to the Namespace add method.
	 * The default handlers provided (and included by default) are event, ctor and properties
	 */
	$.entwine.Namespace.addHandler = function(handler) {
		for (var i = 0; i < handlers.length && handlers[i].order < handler.order; i++) { /* Pass */ }
		handlers.splice(i, 0, handler);
	};
	
	$.entwine.Namespace.addHandler({
		order: 50,
		
		bind: function(selector, k, v){
			if ($.isFunction(v)) {
				this.bind_proxy(selector, k, v);
				return true;
			}
		}
	});

	$.extend($.fn, {
		/**
		 * Main entwine function. Used for new definitions, calling into a namespace (or forcing the base namespace) and entering a using block
		 * 
		 */
		entwine: function(spacename) {
			var i = 0;
			/* Don't actually work out selector until we try and define something on it - we might be opening a namespace on an function-traveresed object
			   which have non-standard selectors like .parents(.foo).slice(0,1) */
			var selector = null;  
		
			/* By default we operator on the base namespace */
			var namespace = namespaces.__base || $.entwine.Namespace();
			
			/* If the first argument is a string, then it's the name of a namespace. Look it up */
			if (typeof spacename == 'string') {
				if (spacename.charAt('0') == '.') spacename = spacename.substr(1);
				if (spacename) namespace = namespaces[spacename] || $.entwine.Namespace(spacename);
				i=1;
			}
		
			/* All remaining arguments should either be using blocks or definition hashs */
			while (i < arguments.length) {
				var res = arguments[i++];
				
				// If it's a function, call it - either it's a using block or it's a namespaced entwine definition
				if ($.isFunction(res)) {
					if (res.length != 1) $.entwine.warn('Function block inside entwine definition does not take $ argument properly', $.entwine.WARN_LEVEL_IMPORTANT);
					res = res.call(namespace.$(this), namespace.$);
				}
				
				// If we have a entwine definition hash, inject it into namespace
				if (res) {
					if (selector === null) selector = this.selector ? $.selector(this.selector) : false;
					
					if (selector) namespace.add(selector, res);
					else $.entwine.warn('Entwine block given to entwine call without selector. Make sure you call $(selector).entwine when defining blocks', $.entwine.WARN_LEVEL_IMPORTANT);
				}
			}
		
			/* Finally, return the jQuery object 'this' refers to, wrapped in the new namespace */
			return namespace.$(this);
		},
		
		/** 
		 * Calls the next most specific version of the current entwine method
		 */
		_super: function(){
			var rv, i = this.length;
			while (i--) {
				var el = this[0];
				rv = el.f(el, arguments, el.i);
			}
			return rv;
		}
	});
	
})(jQuery);
