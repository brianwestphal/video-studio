"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // node_modules/kerfjs/dist/chunk-4VT4YZOO.js
  function flatten(segment, withMarkers) {
    if (segment.kind === "static") return segment.html;
    if (segment.kind === "list") {
      const items = segment.items.map((i2) => i2.html).join("");
      return withMarkers ? `<!--kf-list:${segment.id}-->${items}` : items;
    }
    return segment.parts.map((p2) => flatten(p2, withMarkers)).join("");
  }
  function flattenWithoutListItems(segment) {
    if (segment.kind === "static") return segment.html;
    if (segment.kind === "list") return `<!--kf-list:${segment.id}-->`;
    return segment.parts.map(flattenWithoutListItems).join("");
  }
  function collectLists(segment, out = /* @__PURE__ */ new Map()) {
    if (segment.kind === "list") out.set(segment.id, segment);
    else if (segment.kind === "mixed") {
      for (const part of segment.parts) collectLists(part, out);
    }
    return out;
  }
  function mergeChildSegments(parts) {
    if (parts.length === 0) return { kind: "static", html: "" };
    if (parts.every((p2) => p2.kind === "static")) {
      return {
        kind: "static",
        html: parts.map((p2) => p2.html).join("")
      };
    }
    const merged = [];
    let coalesced = "";
    for (const p2 of parts) {
      if (p2.kind === "static") {
        coalesced += p2.html;
      } else {
        if (coalesced !== "") {
          merged.push({ kind: "static", html: coalesced });
          coalesced = "";
        }
        merged.push(p2);
      }
    }
    if (coalesced !== "") merged.push({ kind: "static", html: coalesced });
    return { kind: "mixed", parts: merged };
  }
  function wrapWithTags(child, openTag, closeTag) {
    if (child.kind === "static") {
      return { kind: "static", html: openTag + child.html + closeTag };
    }
    if (child.kind === "mixed") {
      return {
        kind: "mixed",
        parts: [
          { kind: "static", html: openTag },
          ...child.parts,
          { kind: "static", html: closeTag }
        ]
      };
    }
    return {
      kind: "mixed",
      parts: [
        { kind: "static", html: openTag },
        child,
        { kind: "static", html: closeTag }
      ]
    };
  }
  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function isSafeHtml(value) {
    return typeof value === "object" && value !== null && value[SAFE_HTML_BRAND] === true;
  }
  function listSafeHtml(id, items) {
    return new SafeHtml({ kind: "list", id, items });
  }
  function granularListSafeHtml(id, items, patches) {
    return new SafeHtml({ kind: "list", id, items, patches });
  }
  function toSegment(child) {
    if (child == null || typeof child === "boolean") return { kind: "static", html: "" };
    if (isSafeHtml(child)) {
      return child.__segment ?? { kind: "static", html: child.__html };
    }
    if (typeof child === "string") return { kind: "static", html: escapeHtml(child) };
    if (typeof child === "number") return { kind: "static", html: String(child) };
    if (Array.isArray(child)) return mergeChildSegments(child.map(toSegment));
    const maybeNode = child;
    if (typeof maybeNode === "object" && maybeNode !== null && ("nodeType" in maybeNode || "outerHTML" in maybeNode)) {
      throw new Error(
        "JSX: DOM elements cannot be passed as children (the JSX runtime renders to HTML strings). Build the tree in one JSX expression and use querySelector after toElement() to get element refs."
      );
    }
    throw new Error(
      `JSX: unsupported child of type ${describeValue(child)}. Children must be SafeHtml, string, number, boolean, null, undefined, or an array of those. Common mistakes: passing a Signal/Store object directly (use signal.value or store.state.value), passing a function (call it first), or passing a Promise (await it before render).`
    );
  }
  function describeValue(v2) {
    if (Array.isArray(v2)) return "array";
    if (typeof v2 === "object" && v2 !== null) {
      const ctor = v2.constructor?.name;
      return ctor && ctor !== "Object" ? `object (${ctor})` : "object";
    }
    return typeof v2;
  }
  function renderAttr(key, value) {
    const name = ATTR_ALIASES[key] ?? key;
    if (value == null || value === false) return "";
    if (value === true) return ` ${name}`;
    let strValue;
    if (isSafeHtml(value)) {
      strValue = value.__html;
    } else if (typeof value === "number") {
      strValue = String(value);
    } else if (typeof value === "string") {
      if (URL_ATTRS.has(name) && DANGEROUS_URL_RE.test(value)) {
        console.warn(
          `JSX: dropped dangerous URL value for ${name}=${JSON.stringify(value.slice(0, 80))}. kerf blocks javascript:, vbscript:, and data:text/html URLs in href/src/formaction/action/xlink:href by default. Wrap in raw() if this is intentional (e.g. bookmarklets), or sanitize upstream.`
        );
        return "";
      }
      strValue = escapeAttr(value);
    } else if (typeof value === "function" && /^on[A-Z]/.test(key)) {
      throw new Error(
        `JSX: inline event handlers like ${key}={fn} are not supported by kerf's JSX \u2192 HTML-string runtime. Use event delegation from the mount root instead:

  delegate(rootEl, 'click', '[data-action="..."]', (evt, target) => { ... });
  <button data-action="...">click</button>

See docs/5-event-delegation.md for the tier-1/tier-2/tier-3 model.`
      );
    } else {
      throw new Error(
        `JSX: unsupported value for attribute "${key}" \u2014 got ${describeValue(value)}. Attribute values must be string, number, boolean, null, undefined, or SafeHtml. Did you mean to read .value off a Signal, or stringify the object first?`
      );
    }
    return ` ${name}="${strValue}"`;
  }
  function jsx(tag, props) {
    if (typeof tag === "function") return tag(props);
    const { children, ...attrs } = props;
    const attrStr = Object.entries(attrs).map(([k, v2]) => renderAttr(k, v2)).join("");
    if (VOID_TAGS.has(tag)) return new SafeHtml(`<${tag}${attrStr}>`);
    const childSegment = children != null ? toSegment(children) : { kind: "static", html: "" };
    return new SafeHtml(wrapWithTags(childSegment, `<${tag}${attrStr}>`, `</${tag}>`));
  }
  function Fragment({ children }) {
    return new SafeHtml(children != null ? toSegment(children) : { kind: "static", html: "" });
  }
  var ATTR_ALIASES, SAFE_HTML_BRAND, _a, SafeHtml, VOID_TAGS, URL_ATTRS, DANGEROUS_URL_RE;
  var init_chunk_4VT4YZOO = __esm({
    "node_modules/kerfjs/dist/chunk-4VT4YZOO.js"() {
      ATTR_ALIASES = {
        // HTML attributes
        className: "class",
        htmlFor: "for",
        httpEquiv: "http-equiv",
        acceptCharset: "accept-charset",
        accessKey: "accesskey",
        autoCapitalize: "autocapitalize",
        autoComplete: "autocomplete",
        autoFocus: "autofocus",
        autoPlay: "autoplay",
        colSpan: "colspan",
        contentEditable: "contenteditable",
        crossOrigin: "crossorigin",
        dateTime: "datetime",
        defaultChecked: "checked",
        defaultValue: "value",
        encType: "enctype",
        formAction: "formaction",
        formEncType: "formenctype",
        formMethod: "formmethod",
        formNoValidate: "formnovalidate",
        formTarget: "formtarget",
        hrefLang: "hreflang",
        inputMode: "inputmode",
        maxLength: "maxlength",
        minLength: "minlength",
        noModule: "nomodule",
        noValidate: "novalidate",
        readOnly: "readonly",
        referrerPolicy: "referrerpolicy",
        rowSpan: "rowspan",
        spellCheck: "spellcheck",
        srcDoc: "srcdoc",
        srcLang: "srclang",
        srcSet: "srcset",
        tabIndex: "tabindex",
        useMap: "usemap",
        // SVG presentation attributes (camelCase → kebab-case)
        strokeWidth: "stroke-width",
        strokeLinecap: "stroke-linecap",
        strokeLinejoin: "stroke-linejoin",
        strokeDasharray: "stroke-dasharray",
        strokeDashoffset: "stroke-dashoffset",
        strokeMiterlimit: "stroke-miterlimit",
        strokeOpacity: "stroke-opacity",
        fillOpacity: "fill-opacity",
        fillRule: "fill-rule",
        clipPath: "clip-path",
        clipRule: "clip-rule",
        colorInterpolation: "color-interpolation",
        colorInterpolationFilters: "color-interpolation-filters",
        floodColor: "flood-color",
        floodOpacity: "flood-opacity",
        lightingColor: "lighting-color",
        stopColor: "stop-color",
        stopOpacity: "stop-opacity",
        shapeRendering: "shape-rendering",
        imageRendering: "image-rendering",
        textRendering: "text-rendering",
        pointerEvents: "pointer-events",
        vectorEffect: "vector-effect",
        paintOrder: "paint-order",
        // SVG text/font attributes
        fontFamily: "font-family",
        fontSize: "font-size",
        fontStyle: "font-style",
        fontVariant: "font-variant",
        fontWeight: "font-weight",
        fontStretch: "font-stretch",
        textAnchor: "text-anchor",
        textDecoration: "text-decoration",
        dominantBaseline: "dominant-baseline",
        alignmentBaseline: "alignment-baseline",
        baselineShift: "baseline-shift",
        letterSpacing: "letter-spacing",
        wordSpacing: "word-spacing",
        writingMode: "writing-mode",
        // SVG marker attributes
        markerStart: "marker-start",
        markerMid: "marker-mid",
        markerEnd: "marker-end",
        // SVG xlink (legacy but still used)
        xlinkHref: "xlink:href",
        xlinkShow: "xlink:show",
        xlinkActuate: "xlink:actuate",
        xlinkType: "xlink:type",
        xlinkRole: "xlink:role",
        xlinkTitle: "xlink:title",
        xlinkArcrole: "xlink:arcrole",
        xmlBase: "xml:base",
        xmlLang: "xml:lang",
        xmlSpace: "xml:space",
        xmlnsXlink: "xmlns:xlink"
      };
      SAFE_HTML_BRAND = /* @__PURE__ */ Symbol.for("kerfjs.SafeHtml");
      SafeHtml = (_a = SAFE_HTML_BRAND, class {
        constructor(input) {
          __publicField(this, "__html");
          __publicField(this, "__segment");
          // Branded so `isSafeHtml()` recognizes instances from any copy of this module.
          __publicField(this, _a, true);
          if (typeof input === "string") {
            this.__segment = { kind: "static", html: input };
            this.__html = input;
          } else {
            this.__segment = input;
            this.__html = flatten(input, false);
          }
        }
        toString() {
          return this.__html;
        }
      });
      VOID_TAGS = /* @__PURE__ */ new Set([
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr"
      ]);
      URL_ATTRS = /* @__PURE__ */ new Set(["href", "src", "xlink:href", "formaction", "action"]);
      DANGEROUS_URL_RE = /^\s*(?:(?:java|vb)script:|data:text\/html[;,])/i;
    }
  });

  // node_modules/@preact/signals-core/dist/signals-core.module.js
  function t() {
    if (!(s > 1)) {
      var i2, t2 = false;
      !(function() {
        var i3 = c;
        c = void 0;
        while (void 0 !== i3) {
          if (i3.S.v === i3.v) i3.S.i = i3.i;
          i3 = i3.o;
        }
      })();
      while (void 0 !== h) {
        var n2 = h;
        h = void 0;
        v++;
        while (void 0 !== n2) {
          var r2 = n2.u;
          n2.u = void 0;
          n2.f &= -3;
          if (!(8 & n2.f) && w(n2)) try {
            n2.c();
          } catch (n3) {
            if (!t2) {
              i2 = n3;
              t2 = true;
            }
          }
          n2 = r2;
        }
      }
      v = 0;
      s--;
      if (t2) throw i2;
    } else s--;
  }
  function o(i2) {
    var t2 = r;
    r = void 0;
    try {
      return i2();
    } finally {
      r = t2;
    }
  }
  function a(i2) {
    if (void 0 !== r) {
      var t2 = i2.n;
      if (void 0 === t2 || t2.t !== r) {
        t2 = { i: 0, S: i2, p: r.s, n: void 0, t: r, e: void 0, x: void 0, r: t2 };
        if (void 0 !== r.s) r.s.n = t2;
        r.s = t2;
        i2.n = t2;
        if (32 & r.f) i2.S(t2);
        return t2;
      } else if (-1 === t2.i) {
        t2.i = 0;
        if (void 0 !== t2.n) {
          t2.n.p = t2.p;
          if (void 0 !== t2.p) t2.p.n = t2.n;
          t2.p = r.s;
          t2.n = void 0;
          r.s.n = t2;
          r.s = t2;
        }
        return t2;
      }
    }
  }
  function l(i2, t2) {
    this.v = i2;
    this.i = 0;
    this.n = void 0;
    this.t = void 0;
    this.l = 0;
    this.W = null == t2 ? void 0 : t2.watched;
    this.Z = null == t2 ? void 0 : t2.unwatched;
    this.name = null == t2 ? void 0 : t2.name;
  }
  function y(i2, t2) {
    return new l(i2, t2);
  }
  function w(i2) {
    for (var t2 = i2.s; void 0 !== t2; t2 = t2.n) if (t2.S.i !== t2.i || !t2.S.h() || t2.S.i !== t2.i) return true;
    return false;
  }
  function _(i2) {
    for (var t2 = i2.s; void 0 !== t2; t2 = t2.n) {
      var n2 = t2.S.n;
      if (void 0 !== n2) t2.r = n2;
      t2.S.n = t2;
      t2.i = -1;
      if (void 0 === t2.n) {
        i2.s = t2;
        break;
      }
    }
  }
  function b(i2) {
    var t2 = i2.s, n2 = void 0;
    while (void 0 !== t2) {
      var r2 = t2.p;
      if (-1 === t2.i) {
        t2.S.U(t2);
        if (void 0 !== r2) r2.n = t2.n;
        if (void 0 !== t2.n) t2.n.p = r2;
      } else n2 = t2;
      t2.S.n = t2.r;
      if (void 0 !== t2.r) t2.r = void 0;
      t2 = r2;
    }
    i2.s = n2;
  }
  function p(i2, t2) {
    l.call(this, void 0, t2);
    this.x = i2;
    this.s = void 0;
    this.g = d - 1;
    this.f = 4;
  }
  function S(i2) {
    var n2 = i2.m;
    i2.m = void 0;
    if ("function" == typeof n2) {
      s++;
      var o2 = r;
      r = void 0;
      try {
        n2();
      } catch (t2) {
        i2.f &= -2;
        i2.f |= 8;
        m(i2);
        throw t2;
      } finally {
        r = o2;
        t();
      }
    }
  }
  function m(i2) {
    for (var t2 = i2.s; void 0 !== t2; t2 = t2.n) t2.S.U(t2);
    i2.x = void 0;
    i2.s = void 0;
    S(i2);
  }
  function x(i2) {
    if (r !== this) throw new Error("Out-of-order effect");
    b(this);
    r = i2;
    this.f &= -2;
    if (8 & this.f) m(this);
    t();
  }
  function E(i2, t2) {
    this.x = i2;
    this.m = void 0;
    this.s = void 0;
    this.u = void 0;
    this.f = 32;
    this.name = null == t2 ? void 0 : t2.name;
    if (f) f.push(this);
  }
  function j(i2, t2) {
    var n2 = new E(i2, t2);
    try {
      n2.c();
    } catch (i3) {
      n2.d();
      throw i3;
    }
    var r2 = n2.d.bind(n2);
    r2[Symbol.dispose] = r2;
    return r2;
  }
  var i, r, f, h, s, v, e, c, d;
  var init_signals_core_module = __esm({
    "node_modules/@preact/signals-core/dist/signals-core.module.js"() {
      i = Symbol.for("preact-signals");
      r = void 0;
      h = void 0;
      s = 0;
      v = 0;
      e = 0;
      c = void 0;
      d = 0;
      l.prototype.brand = i;
      l.prototype.h = function() {
        return true;
      };
      l.prototype.S = function(i2) {
        var t2 = this, n2 = this.t;
        if (n2 !== i2 && void 0 === i2.e) {
          i2.x = n2;
          this.t = i2;
          if (void 0 !== n2) n2.e = i2;
          else o(function() {
            var i3;
            null == (i3 = t2.W) || i3.call(t2);
          });
        }
      };
      l.prototype.U = function(i2) {
        var t2 = this;
        if (void 0 !== this.t) {
          var n2 = i2.e, r2 = i2.x;
          if (void 0 !== n2) {
            n2.x = r2;
            i2.e = void 0;
          }
          if (void 0 !== r2) {
            r2.e = n2;
            i2.x = void 0;
          }
          if (i2 === this.t) {
            this.t = r2;
            if (void 0 === r2) o(function() {
              var i3;
              null == (i3 = t2.Z) || i3.call(t2);
            });
          }
        }
      };
      l.prototype.subscribe = function(i2) {
        var t2 = this;
        return j(function() {
          var n2 = t2.value;
          o(function() {
            return i2(n2);
          });
        }, { name: "sub" });
      };
      l.prototype.valueOf = function() {
        return this.value;
      };
      l.prototype.toString = function() {
        return this.value + "";
      };
      l.prototype.toJSON = function() {
        return this.value;
      };
      l.prototype.peek = function() {
        var i2 = this;
        return o(function() {
          return i2.value;
        });
      };
      Object.defineProperty(l.prototype, "value", { get: function() {
        var i2 = a(this);
        if (void 0 !== i2) i2.i = this.i;
        return this.v;
      }, set: function(i2) {
        if (i2 !== this.v) {
          if (v > 100) throw new Error("Cycle detected");
          !(function(i3) {
            if (0 !== s && 0 === v) {
              if (i3.l !== e) {
                i3.l = e;
                c = { S: i3, v: i3.v, i: i3.i, o: c };
              }
            }
          })(this);
          this.v = i2;
          this.i++;
          d++;
          s++;
          try {
            for (var n2 = this.t; void 0 !== n2; n2 = n2.x) n2.t.N();
          } finally {
            t();
          }
        }
      } });
      p.prototype = new l();
      p.prototype.h = function() {
        this.f &= -3;
        if (1 & this.f) return false;
        if (32 == (36 & this.f)) return true;
        this.f &= -5;
        if (this.g === d) return true;
        this.g = d;
        this.f |= 1;
        if (this.i > 0 && !w(this)) {
          this.f &= -2;
          return true;
        }
        var i2 = r;
        try {
          _(this);
          r = this;
          var t2 = this.x();
          if (16 & this.f || this.v !== t2 || 0 === this.i) {
            this.v = t2;
            this.f &= -17;
            this.i++;
          }
        } catch (i3) {
          this.v = i3;
          this.f |= 16;
          this.i++;
        }
        r = i2;
        b(this);
        this.f &= -2;
        return true;
      };
      p.prototype.S = function(i2) {
        if (void 0 === this.t) {
          this.f |= 36;
          for (var t2 = this.s; void 0 !== t2; t2 = t2.n) t2.S.S(t2);
        }
        l.prototype.S.call(this, i2);
      };
      p.prototype.U = function(i2) {
        if (void 0 !== this.t) {
          l.prototype.U.call(this, i2);
          if (void 0 === this.t) {
            this.f &= -33;
            for (var t2 = this.s; void 0 !== t2; t2 = t2.n) t2.S.U(t2);
          }
        }
      };
      p.prototype.N = function() {
        if (!(2 & this.f)) {
          this.f |= 6;
          for (var i2 = this.t; void 0 !== i2; i2 = i2.x) i2.t.N();
        }
      };
      Object.defineProperty(p.prototype, "value", { get: function() {
        if (1 & this.f) throw new Error("Cycle detected");
        var i2 = a(this);
        this.h();
        if (void 0 !== i2) i2.i = this.i;
        if (16 & this.f) throw this.v;
        return this.v;
      } });
      E.prototype.c = function() {
        var i2 = this.S();
        try {
          if (8 & this.f) return;
          if (void 0 === this.x) return;
          var t2 = this.x();
          if ("function" == typeof t2) this.m = t2;
        } finally {
          i2();
        }
      };
      E.prototype.S = function() {
        if (1 & this.f) throw new Error("Cycle detected");
        this.f |= 1;
        this.f &= -9;
        S(this);
        _(this);
        s++;
        var i2 = r;
        r = this;
        return x.bind(this, i2);
      };
      E.prototype.N = function() {
        if (!(2 & this.f)) {
          this.f |= 2;
          this.u = h;
          h = this;
        }
      };
      E.prototype.d = function() {
        this.f |= 8;
        if (!(1 & this.f)) m(this);
      };
      E.prototype.dispose = function() {
        this.d();
      };
    }
  });

  // node_modules/kerfjs/dist/chunk-N4KF3GD2.js
  function isOptedIn() {
    const proc = globalThis.process;
    if (proc?.env?.NODE_ENV === "production") return false;
    return proc?.env?.KERF_DEV_WARN_DELEGATE_IN_EFFECT === "1";
  }
  function enterEffect() {
    depth++;
  }
  function exitEffect() {
    depth--;
  }
  function isDevWarnDelegateInEffectEnabled() {
    return isOptedIn();
  }
  function warnIfInsideEffect(fn) {
    if (!isOptedIn()) return;
    if (depth === 0) return;
    if (warned) return;
    warned = true;
    console.warn(
      `kerf: ${fn}() was called inside an effect() body. Every effect re-run installs a fresh root listener; the effect disposer cleans up the reactive subscription but not the listeners, so listener count grows linearly with signal churn and each listener pins its handler closure. Register the delegate once at module or setup scope and gate behavior on the signal *inside the handler* where the read is free. See docs/5-event-delegation.md \xA75.3 "When capturing the disposer still isn't enough". Set KERF_DEV_WARN_DELEGATE_IN_EFFECT=0 (or unset it) to silence this warning.`
    );
  }
  function isDevWarnUntrackedEnabled() {
    const proc = globalThis.process;
    if (proc?.env?.NODE_ENV === "production") return false;
    return proc?.env?.KERF_DEV_WARN_UNTRACKED_SIGNALS === "1";
  }
  function signal(value) {
    if (isDevWarnUntrackedEnabled()) return new DevSignal(value);
    return y(value);
  }
  function effect(fn) {
    if (!isDevWarnDelegateInEffectEnabled()) return j(fn);
    return j(() => {
      enterEffect();
      try {
        return fn();
      } finally {
        exitEffect();
      }
    });
  }
  var depth, warned, WARNING_MESSAGE, DevSignal;
  var init_chunk_N4KF3GD2 = __esm({
    "node_modules/kerfjs/dist/chunk-N4KF3GD2.js"() {
      init_signals_core_module();
      depth = 0;
      warned = false;
      WARNING_MESSAGE = "kerf: signal was written but has no subscribers. Did you read `.value` outside of a render fn / effect()? Hoisted reads do not subscribe, so subsequent writes will not re-render. Move the read inside mount()'s render fn or effect() callback. Set KERF_DEV_WARN_UNTRACKED_SIGNALS=0 (or unset it) to silence this warning.";
      DevSignal = class extends l {
        constructor(initial) {
          super(initial, {
            watched() {
              this.__hasSubscriber = true;
            }
          });
          __publicField(this, "__hasSubscriber", false);
          __publicField(this, "__warned", false);
          __publicField(this, "__constructed", false);
          this.__constructed = true;
        }
        get value() {
          return super.value;
        }
        set value(v2) {
          super.value = v2;
          if (this.__constructed && !this.__hasSubscriber && !this.__warned) {
            this.__warned = true;
            console.warn(WARNING_MESSAGE);
          }
        }
      };
    }
  });

  // node_modules/kerfjs/dist/index.js
  function cssEscapeIdent(value) {
    if (value === "") {
      throw new Error("attr: attribute name must not be empty");
    }
    const str = String(value);
    let result = "";
    for (let i2 = 0; i2 < str.length; i2++) {
      const cp = str.charCodeAt(i2);
      const ch = str.charAt(i2);
      if (cp === 0) {
        result += "\uFFFD";
        continue;
      }
      if (cp >= 1 && cp <= 31 || cp === 127) {
        result += "\\" + cp.toString(16) + " ";
        continue;
      }
      if (i2 === 0 && cp >= 48 && cp <= 57) {
        result += "\\" + cp.toString(16) + " ";
        continue;
      }
      if (i2 === 1 && cp >= 48 && cp <= 57 && str.charCodeAt(0) === 45) {
        result += "\\" + cp.toString(16) + " ";
        continue;
      }
      if (cp >= 128 || cp === 45 || // `-`
      cp === 95 || // `_`
      cp >= 48 && cp <= 57 || // 0-9
      cp >= 65 && cp <= 90 || // A-Z
      cp >= 97 && cp <= 122) {
        result += ch;
        continue;
      }
      result += "\\" + ch;
    }
    return result;
  }
  function escapeCSSString(value) {
    let result = "";
    for (let i2 = 0; i2 < value.length; i2++) {
      const cp = value.charCodeAt(i2);
      const ch = value.charAt(i2);
      if (cp === 0) {
        result += "\uFFFD";
      } else if (cp >= 1 && cp <= 31 || cp === 127) {
        result += "\\" + cp.toString(16) + " ";
      } else if (cp === 92) {
        result += "\\\\";
      } else if (cp === 34) {
        result += '\\"';
      } else {
        result += ch;
      }
    }
    return result;
  }
  function attr(name, value) {
    const escapedName = cssEscapeIdent(name);
    if (value !== void 0) {
      const selector = `[${escapedName}="${escapeCSSString(value)}"]`;
      return Object.freeze({
        name,
        value,
        selector,
        attrs: Object.freeze({ [name]: value })
      });
    }
    return (v2) => Object.freeze({ [name]: v2 });
  }
  function assertValidSelector(selector, fn) {
    try {
      document.createElement("div").matches(selector);
    } catch {
      throw new Error(
        `${fn}: invalid selector "${selector}". Pass a valid CSS selector (e.g. '[data-action="add"]', '.btn', 'input').`
      );
    }
  }
  function delegate(rootEl, type, selector, handler) {
    assertValidSelector(selector, "delegate");
    warnIfInsideEffect("delegate");
    const listener = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const matched = target.closest(selector);
      if (matched !== null && rootEl.contains(matched)) {
        handler(event, matched);
      }
    };
    const capture = NON_BUBBLING.has(type);
    rootEl.addEventListener(type, listener, capture);
    return () => {
      rootEl.removeEventListener(type, listener, capture);
    };
  }
  function isOptedIn2() {
    const proc = globalThis.process;
    if (proc?.env?.NODE_ENV === "production") return false;
    return proc?.env?.KERF_DEV_WARN_EACH_IN_MORPH_SKIP === "1";
  }
  function hasMorphSkipAncestor(el, root) {
    let ancestor = el.parentElement;
    while (ancestor !== null && ancestor !== root) {
      if (ancestor.dataset.morphSkip !== void 0) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }
  function maybeWarnEachInMorphSkip(id, liveParent, rootEl) {
    if (!isOptedIn2()) return;
    if (warnedIds.has(id)) return;
    if (!hasMorphSkipAncestor(liveParent, rootEl)) return;
    warnedIds.add(id);
    console.warn(
      `kerf: each() list '${id}' is inside a data-morph-skip subtree. The keyed reconciler still updates the list rows, but any static signal-reactive JSX inside the same skipped ancestor (e.g. <p>{count.value}</p>) is frozen \u2014 the morph never visits it. Remove data-morph-skip from any element that contains reactive JSX content and reserve it for truly library-owned hosts. Set KERF_DEV_WARN_EACH_IN_MORPH_SKIP=0 (or unset it) to silence this warning.`
    );
  }
  function isOptedInDupKeys() {
    const proc = globalThis.process;
    if (proc?.env?.NODE_ENV === "production") return false;
    return proc?.env?.KERF_DEV_WARN_DUPLICATE_EACH_KEYS === "1";
  }
  function maybeWarnDuplicateCacheKeys(id, segItems) {
    if (!isOptedInDupKeys()) return;
    if (warnedDupIds.has(id)) return;
    const seen = /* @__PURE__ */ new Set();
    for (const si of segItems) {
      if (seen.has(si.cacheKey)) {
        warnedDupIds.add(id);
        console.warn(
          `kerf: each() list '${id}' has duplicate cacheKey values (duplicate: ${String(si.cacheKey)}). The cacheKey function should return a unique value per row so kerf can tell apart items for memoization \u2014 duplicate values cause some rows to return stale cached HTML when external state that affects their render changes. Set KERF_DEV_WARN_DUPLICATE_EACH_KEYS=0 (or unset it) to silence this warning.`
        );
        return;
      }
      seen.add(si.cacheKey);
    }
  }
  function isArraySignal(value) {
    return typeof value === "object" && value !== null && value[ARRAY_SIGNAL_BRAND] === true;
  }
  function _setRenderContext(c2) {
    context = c2;
  }
  function each(items, render, cacheKey) {
    if (isArraySignal(items) && context !== null) {
      return eachGranular(items, render, cacheKey);
    }
    const snapshotItems = isArraySignal(items) ? items.value : items;
    return eachSnapshot(snapshotItems, render, cacheKey);
  }
  function eachSnapshot(items, render, cacheKey) {
    let id;
    if (context !== null) {
      id = String(context.counter++);
    } else {
      id = "orphan";
    }
    return eachSnapshotById(items, render, cacheKey, id);
  }
  function eachGranular(sig, render, cacheKey) {
    const ctx = context;
    const id = String(ctx.counter++);
    const previousBindingCount = ctx.bindingCounts.get(id);
    const patches = sig._consumePatches();
    const snapshot = sig.value;
    if (previousBindingCount === void 0 || previousBindingCount === 0 || patches.length === 0) {
      return eachSnapshotById(snapshot, render, cacheKey, id);
    }
    let netDelta = 0;
    for (const p2 of patches) {
      if (p2.type === "insert") netDelta += 1;
      else if (p2.type === "remove") netDelta -= 1;
      else if (p2.type === "replace") {
        return eachSnapshotById(snapshot, render, cacheKey, id);
      }
    }
    if (previousBindingCount + netDelta !== snapshot.length) {
      return eachSnapshotById(snapshot, render, cacheKey, id);
    }
    if (cacheKey !== void 0) {
      const cache = ctx.caches.get(id);
      for (let i2 = 0; i2 < snapshot.length; i2++) {
        const item = snapshot[i2];
        const k = cacheKey(item, i2);
        const cached = cache.get(item);
        if (cached !== void 0 && cached.cacheKey !== k) {
          return eachSnapshotById(snapshot, render, cacheKey, id);
        }
      }
    }
    const renderFnInternal = (item, index) => {
      const out = render(item, index);
      return isSafeHtml(out) ? out.toString() : out;
    };
    const internalPatches = new Array(patches.length);
    try {
      for (let i2 = 0; i2 < patches.length; i2++) {
        const p2 = patches[i2];
        if (p2.type === "insert" || p2.type === "update") {
          internalPatches[i2] = {
            type: p2.type,
            index: p2.index,
            item: p2.item,
            html: renderFnInternal(p2.item, p2.index)
          };
        } else {
          internalPatches[i2] = p2;
        }
      }
    } catch {
      ctx.bindingCounts.delete(id);
      return eachSnapshotById(snapshot, render, cacheKey, id);
    }
    return granularListSafeHtml(id, [], internalPatches);
  }
  function eachSnapshotById(items, render, cacheKey, id) {
    let cache = null;
    if (context !== null) {
      let c2 = context.caches.get(id);
      if (c2 === void 0) {
        c2 = /* @__PURE__ */ new WeakMap();
        context.caches.set(id, c2);
      }
      cache = c2;
    }
    const segItems = new Array(items.length);
    const seen = /* @__PURE__ */ new Set();
    for (let i2 = 0; i2 < items.length; i2++) {
      const item = items[i2];
      if (typeof item !== "object" || item === null) {
        throw new Error(
          `each(): items must be objects (the per-item HTML cache is a WeakMap), got ${item === null ? "null" : typeof item} at index ${i2}. Wrap primitives if you need to iterate them, e.g. items.map(v => ({ v })).`
        );
      }
      if (seen.has(item)) {
        throw new Error(
          `each(): the same object reference appears at multiple indices in items (first seen earlier, again at index ${i2}). The per-item HTML cache is keyed on object identity, so duplicate references break the keyed reconciler and can leak DOM nodes on re-render. Use a fresh object per row (e.g. items.map(o => ({ ...o })) before passing to each()).`
        );
      }
      seen.add(item);
      const k = cacheKey ? cacheKey(item, i2) : void 0;
      let html;
      const cached = cache !== null ? cache.get(item) : void 0;
      if (cached !== void 0 && cached.cacheKey === k) {
        html = cached.html;
      } else {
        const out = render(item, i2);
        html = isSafeHtml(out) ? out.toString() : out;
        if (cache !== null) cache.set(item, { cacheKey: k, html });
      }
      segItems[i2] = { ref: item, cacheKey: k, html };
    }
    if (cacheKey !== void 0) {
      maybeWarnDuplicateCacheKeys(id, segItems);
    }
    return listSafeHtml(id, segItems);
  }
  function getNodeKey(node) {
    if (node.nodeType !== ELEMENT_NODE) return void 0;
    const el = node;
    if (el.id !== "") return `${ID_KEY_PREFIX}${el.id}`;
    if (el.dataset !== void 0 && el.dataset.key !== void 0) {
      return `${DATA_KEY_PREFIX}${el.dataset.key}`;
    }
    return void 0;
  }
  function morph(liveRoot, template, ownedItems = EMPTY_OWNED) {
    const templateEl = isElementNode(template) ? template : parseTemplate(liveRoot, template);
    morphChildren(liveRoot, templateEl, ownedItems);
  }
  function _morphElement(fromEl, toEl, ownedItems = EMPTY_OWNED) {
    morphElement(fromEl, toEl, ownedItems);
  }
  function isElementNode(t2) {
    return typeof t2 === "object" && t2 !== null && t2.nodeType === ELEMENT_NODE;
  }
  function parseTemplate(liveRoot, template) {
    const el = liveRoot.cloneNode(false);
    el.innerHTML = String(template);
    return el;
  }
  function skipOwned(node, ownedItems) {
    while (node !== null && node.nodeType === ELEMENT_NODE && ownedItems.has(node)) {
      node = node.nextSibling;
    }
    return node;
  }
  function morphChildren(fromParent, toParent, ownedItems) {
    const keyed = /* @__PURE__ */ new Map();
    for (let c2 = fromParent.firstChild; c2 !== null; c2 = c2.nextSibling) {
      if (c2.nodeType === ELEMENT_NODE && ownedItems.has(c2)) continue;
      const k = getNodeKey(c2);
      if (k !== void 0) keyed.set(k, c2);
    }
    let fromChild = skipOwned(fromParent.firstChild, ownedItems);
    let toChild = toParent.firstChild;
    while (toChild !== null) {
      const toNext = toChild.nextSibling;
      let matched = null;
      const toKey = getNodeKey(toChild);
      if (toKey !== void 0 && keyed.has(toKey)) {
        matched = keyed.get(toKey);
        keyed.delete(toKey);
        if (matched !== fromChild) {
          fromParent.insertBefore(matched, fromChild);
        } else {
          fromChild = skipOwned(fromChild.nextSibling, ownedItems);
        }
      }
      if (matched === null && fromChild !== null && fromChild.nodeType === toChild.nodeType && (toChild.nodeType !== ELEMENT_NODE || fromChild.tagName === toChild.tagName && getNodeKey(fromChild) === void 0)) {
        matched = fromChild;
        fromChild = skipOwned(fromChild.nextSibling, ownedItems);
      }
      if (matched !== null) {
        morphNode(matched, toChild, ownedItems);
      } else {
        const cloned = toChild.cloneNode(true);
        fromParent.insertBefore(cloned, fromChild);
      }
      toChild = toNext;
    }
    while (fromChild !== null) {
      const next = fromChild.nextSibling;
      if (fromChild.nodeType === ELEMENT_NODE) {
        const el = fromChild;
        if (!ownedItems.has(el) && el.dataset.morphPreserve === void 0) {
          fromParent.removeChild(fromChild);
        }
      } else {
        fromParent.removeChild(fromChild);
      }
      fromChild = next;
    }
  }
  function morphNode(fromNode, toNode, ownedItems) {
    if (fromNode.nodeType === ELEMENT_NODE) {
      morphElement(fromNode, toNode, ownedItems);
      return;
    }
    if (fromNode.nodeType === TEXT_NODE || fromNode.nodeType === COMMENT_NODE) {
      const fromText = fromNode;
      const toText = toNode;
      if (fromText.data !== toText.data) fromText.data = toText.data;
    }
  }
  function morphElement(fromEl, toEl, ownedItems) {
    if (fromEl.tagName !== toEl.tagName) {
      const replacement = toEl.cloneNode(true);
      fromEl.parentNode?.replaceChild(replacement, fromEl);
      return;
    }
    if (fromEl.dataset.morphSkip !== void 0) return;
    if (fromEl.isEqualNode(toEl)) return;
    if (fromEl === document.activeElement) {
      const ce = fromEl.getAttribute("contenteditable");
      if (ce !== null && ce.toLowerCase() !== "false") return;
      if (isTextInputOrTextarea(fromEl)) preserveTextEntryState(fromEl, toEl);
    }
    morphAttributes(fromEl, toEl);
    if (fromEl.dataset.morphSkipChildren !== void 0) return;
    morphChildren(fromEl, toEl, ownedItems);
  }
  function isUserAgentOwnedAttr(tagName, name) {
    return name === "open" && (tagName === "DETAILS" || tagName === "DIALOG");
  }
  function morphAttributes(fromEl, toEl) {
    const toAttrs = toEl.attributes;
    for (let i2 = 0; i2 < toAttrs.length; i2++) {
      const attr2 = toAttrs[i2];
      const ns = attr2.namespaceURI;
      const name = attr2.localName;
      const value = attr2.value;
      if (ns !== null) {
        if (fromEl.getAttributeNS(ns, name) !== value) {
          fromEl.setAttributeNS(ns, attr2.name, value);
        }
      } else if (fromEl.getAttribute(name) !== value) {
        fromEl.setAttribute(name, value);
      }
    }
    const fromAttrs = fromEl.attributes;
    const fromTag = fromEl.tagName;
    for (let i2 = fromAttrs.length - 1; i2 >= 0; i2--) {
      const attr2 = fromAttrs[i2];
      const ns = attr2.namespaceURI;
      const name = attr2.localName;
      if (ns !== null) {
        if (!toEl.hasAttributeNS(ns, name)) fromEl.removeAttributeNS(ns, name);
      } else if (!toEl.hasAttribute(name) && !isUserAgentOwnedAttr(fromTag, name)) {
        fromEl.removeAttribute(name);
      }
    }
  }
  function isTextInputOrTextarea(el) {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const type = el.type;
      return type === "text" || type === "search" || type === "url" || type === "email" || type === "tel" || type === "password" || type === "";
    }
    return false;
  }
  function preserveTextEntryState(fromEl, toEl) {
    if (fromEl.tagName === "TEXTAREA" || fromEl.tagName === "INPUT") {
      const fromInput = fromEl;
      const toInput = toEl;
      toInput.value = fromInput.value;
      try {
        toInput.setSelectionRange(fromInput.selectionStart, fromInput.selectionEnd);
      } catch {
      }
    }
  }
  function isOptedIn22() {
    const proc = globalThis.process;
    if (proc?.env?.NODE_ENV === "production") return false;
    return proc?.env?.KERF_DEV_WARN_REBUILT_LISTENERS === "1";
  }
  function findAddEventListenerProto() {
    const probe = document.createElement("div");
    let proto = Object.getPrototypeOf(probe);
    while (!Object.prototype.hasOwnProperty.call(proto, "addEventListener")) {
      proto = Object.getPrototypeOf(proto);
    }
    return proto;
  }
  function patchAddEventListenerOnce() {
    if (patched) return;
    patched = true;
    const proto = findAddEventListenerProto();
    const orig = proto.addEventListener;
    proto.addEventListener = function(type, listener, options) {
      if (this instanceof Element) {
        this[LISTENER_MARKER] = true;
      }
      return orig.call(this, type, listener, options);
    };
  }
  function hasMarkedListener(el) {
    if (el[LISTENER_MARKER] === true) return true;
    const stack = [];
    for (let i2 = 0; i2 < el.children.length; i2++) stack.push(el.children[i2]);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur[LISTENER_MARKER] === true) return true;
      for (let i2 = 0; i2 < cur.children.length; i2++) stack.push(cur.children[i2]);
    }
    return false;
  }
  function emitWarning() {
    if (warned2) return;
    warned2 = true;
    console.warn(
      "kerf: a node inside a mount()-managed tree was removed/rebuilt while carrying an imperative addEventListener listener. The listener is gone with the old node. Use `delegate(rootEl, 'click', '[data-action=\"...\"]', handler)` so the listener lives on a stable ancestor and survives re-renders, or wrap the host in `data-morph-skip` if the subtree is library-owned (Monaco, xterm, D3 charts). Set KERF_DEV_WARN_REBUILT_LISTENERS=0 (or unset it) to silence this warning."
    );
  }
  function installListenerRebuildWarn(rootEl) {
    if (!isOptedIn22()) return null;
    patchAddEventListenerOnce();
    const observer = new MutationObserver((mutations) => {
      if (warned2) return;
      for (const m2 of mutations) {
        for (let i2 = 0; i2 < m2.removedNodes.length; i2++) {
          const removed = m2.removedNodes[i2];
          if (!(removed instanceof Element)) continue;
          if (hasMarkedListener(removed)) {
            emitWarning();
            return;
          }
        }
      }
    });
    observer.observe(rootEl, { childList: true, subtree: true });
    return observer;
  }
  function endAnchor(binding) {
    if (binding.items.length > 0) {
      return binding.items[binding.items.length - 1].node.nextElementSibling;
    }
    return binding.marker.nextElementSibling;
  }
  function isWhitespace(cc) {
    return cc === 32 || cc === 9 || cc === 10 || cc === 13;
  }
  function tryAttributeOnlyFastPath(liveNode, oldHtml, newHtml) {
    const oldGt = oldHtml.indexOf(">");
    const newGt = newHtml.indexOf(">");
    if (oldGt === -1 || newGt === -1) return false;
    if (oldHtml.length - oldGt !== newHtml.length - newGt) return false;
    if (oldHtml.slice(oldGt) !== newHtml.slice(newGt)) return false;
    if (containsDataMorphSkip(oldHtml) || containsDataMorphSkip(newHtml)) return false;
    const oldTag = parseOpeningTag(oldHtml, oldGt);
    const newTag = parseOpeningTag(newHtml, newGt);
    if (oldTag === null || newTag === null) return false;
    if (oldTag.tagName !== newTag.tagName) return false;
    for (const name of oldTag.attrs.keys()) {
      if (name.indexOf(":") !== -1) return false;
    }
    for (const name of newTag.attrs.keys()) {
      if (name.indexOf(":") !== -1) return false;
    }
    const liveTagUpper = liveNode.tagName;
    for (const [name, rawValue] of newTag.attrs) {
      const oldValue = oldTag.attrs.get(name);
      if (oldValue === rawValue) continue;
      liveNode.setAttribute(name, unescapeAttrValue(rawValue));
    }
    for (const name of oldTag.attrs.keys()) {
      if (newTag.attrs.has(name)) continue;
      if (isUserAgentOwnedAttr2(liveTagUpper, name)) continue;
      liveNode.removeAttribute(name);
    }
    return true;
  }
  function tryTextContentFastPath(liveNode, oldHtml, newHtml) {
    if (containsDataMorphSkip(oldHtml) || containsDataMorphSkip(newHtml)) return false;
    let p2 = 0;
    const minLen = Math.min(oldHtml.length, newHtml.length);
    while (p2 < minLen && oldHtml.charCodeAt(p2) === newHtml.charCodeAt(p2)) p2++;
    let s2 = 0;
    const maxS = minLen - p2;
    while (s2 < maxS && oldHtml.charCodeAt(oldHtml.length - 1 - s2) === newHtml.charCodeAt(newHtml.length - 1 - s2)) {
      s2++;
    }
    const oldWinEnd = oldHtml.length - s2;
    const newWinEnd = newHtml.length - s2;
    if (!isPureTextWindow(oldHtml, p2, oldWinEnd)) return false;
    if (!isPureTextWindow(newHtml, p2, newWinEnd)) return false;
    if (p2 === 0) return false;
    const boundaryCc = oldHtml.charCodeAt(p2 - 1);
    if (boundaryCc === LT || boundaryCc === DQUOTE || boundaryCc === SQUOTE || boundaryCc === EQ || boundaryCc === AMP) return false;
    const textStart = lastIndexOfChar(oldHtml, GT, p2 - 1);
    if (textStart === -1) return false;
    const textEnd = oldHtml.indexOf("<", p2);
    if (textEnd === -1) return false;
    if (textEnd < oldWinEnd) return false;
    const newTextEnd = textEnd + (newHtml.length - oldHtml.length);
    const oldText = oldHtml.slice(textStart + 1, textEnd);
    const newText = newHtml.slice(textStart + 1, newTextEnd);
    const textIdx = countTextNodesBefore(oldHtml, textStart + 1);
    const targetNode = nthTextNodeDescendant(liveNode, textIdx);
    if (targetNode === null) return false;
    if (targetNode.nodeValue !== oldText) return false;
    targetNode.nodeValue = newText;
    return true;
  }
  function containsDataMorphSkip(html) {
    return html.indexOf("data-morph-skip") !== -1;
  }
  function isPureTextWindow(html, start, end) {
    for (let i2 = start; i2 < end; i2++) {
      const cc = html.charCodeAt(i2);
      if (cc === LT || cc === GT || cc === DQUOTE || cc === SQUOTE || cc === AMP || cc === EQ) return false;
    }
    return true;
  }
  function lastIndexOfChar(html, target, beforeInclusive) {
    for (let i2 = beforeInclusive; i2 >= 0; i2--) {
      if (html.charCodeAt(i2) === target) return i2;
    }
    return -1;
  }
  function countTextNodesBefore(html, beforePos) {
    let count = 0;
    let i2 = 0;
    while (i2 < beforePos) {
      if (html.charCodeAt(i2) === LT) {
        while (i2 < beforePos && html.charCodeAt(i2) !== GT) i2++;
        i2++;
      } else {
        const start = i2;
        while (i2 < beforePos && html.charCodeAt(i2) !== LT) i2++;
        if (i2 > start) count++;
      }
    }
    return count;
  }
  function nthTextNodeDescendant(root, n2) {
    let count = 0;
    let result = null;
    function walk(node) {
      for (let c2 = node.firstChild; c2 !== null; c2 = c2.nextSibling) {
        if (result !== null) return;
        if (c2.nodeType === TEXT_NODE2) {
          if (count === n2) {
            result = c2;
            return;
          }
          count++;
        } else if (c2.nodeType === ELEMENT_NODE2) {
          walk(c2);
        }
      }
    }
    walk(root);
    return result;
  }
  function parseOpeningTag(html, gtPos) {
    if (html.charCodeAt(0) !== LT) return null;
    let i2 = 1;
    let end = gtPos;
    if (i2 < end && html.charCodeAt(end - 1) === SLASH) end -= 1;
    const nameStart = i2;
    while (i2 < end) {
      const cc = html.charCodeAt(i2);
      if (isWhitespace(cc)) break;
      i2++;
    }
    const tagName = html.slice(nameStart, i2);
    if (tagName.length === 0) return null;
    const attrs = /* @__PURE__ */ new Map();
    while (i2 < end) {
      while (i2 < end && isWhitespace(html.charCodeAt(i2))) i2++;
      if (i2 >= end) break;
      const aNameStart = i2;
      while (i2 < end) {
        const cc = html.charCodeAt(i2);
        if (cc === EQ || isWhitespace(cc)) break;
        i2++;
      }
      const aName = html.slice(aNameStart, i2);
      if (aName.length === 0) return null;
      while (i2 < end && isWhitespace(html.charCodeAt(i2))) i2++;
      if (i2 < end && html.charCodeAt(i2) === EQ) {
        i2++;
        while (i2 < end && isWhitespace(html.charCodeAt(i2))) i2++;
        if (i2 >= end) return null;
        const q = html.charCodeAt(i2);
        if (q !== DQUOTE && q !== SQUOTE) return null;
        i2++;
        const vStart = i2;
        while (i2 < end && html.charCodeAt(i2) !== q) i2++;
        if (i2 >= end) return null;
        attrs.set(aName, html.slice(vStart, i2));
        i2++;
      } else {
        attrs.set(aName, "");
      }
    }
    return { tagName, attrs };
  }
  function unescapeAttrValue(s2) {
    if (s2.indexOf("&") === -1) return s2;
    return s2.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function isUserAgentOwnedAttr2(tagNameUpper, name) {
    return name === "open" && (tagNameUpper === "DETAILS" || tagNameUpper === "DIALOG");
  }
  function captureFocus(liveParent) {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    if (!liveParent.contains(active)) return null;
    const el = active;
    let selStart = null;
    let selEnd = null;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      try {
        selStart = el.selectionStart;
        selEnd = el.selectionEnd;
      } catch {
      }
    }
    return { el, selStart, selEnd };
  }
  function restoreFocus(snap) {
    if (document.activeElement === snap.el) return;
    if (!snap.el.isConnected) return;
    snap.el.focus();
    if (snap.selStart !== null && snap.selEnd !== null) {
      try {
        snap.el.setSelectionRange(snap.selStart, snap.selEnd);
      } catch {
      }
    }
  }
  function truncateRowHtml(html) {
    return html.length > ROW_HTML_SNIPPET_MAX ? html.slice(0, ROW_HTML_SNIPPET_MAX) + "\u2026" : html;
  }
  function parseRowTemplate(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    return { tpl, count: tpl.content.children.length };
  }
  function rowContractError(index, html) {
    const { count } = parseRowTemplate(html);
    const reason = count === 0 ? "produced no top-level element" : `produced ${count} top-level elements; exactly one is required`;
    return new Error(
      `each(): row render at index ${index} ${reason}. Each item's render must return exactly one element \u2014 wrap multiple roots in a single parent (e.g. <li>...</li>). Got HTML: ${JSON.stringify(truncateRowHtml(html))}`
    );
  }
  function isDevMode() {
    const proc = globalThis.process;
    return proc?.env?.NODE_ENV !== "production";
  }
  function maybeWarnMissingRowKey(rowEl, rowIndex, rowHtml, binding) {
    if (!isDevMode()) return;
    if (binding.warnedMissingKey === true) return;
    binding.warnedMissingKey = true;
    if (rowEl.id !== "" || rowEl.hasAttribute("data-key")) return;
    console.warn(
      `kerf each(): row at index ${rowIndex} has no \`id\` or \`data-key\` attribute. Without one, rows match positionally \u2014 an insert/remove at the head shifts every row's identity, so focused inputs jump to the wrong row, mid-edit textareas swap content with their neighbor, and any per-row state silently follows the wrong item. Add \`data-key={item.id}\` (or set \`id\`) to the top-level element returned by the row render. Row HTML: ${JSON.stringify(truncateRowHtml(rowHtml))}`
    );
  }
  function reconcileGranular(binding, patches) {
    const { liveParent } = binding;
    const items = binding.items;
    const focusSnap = captureFocus(liveParent);
    let i2 = 0;
    while (i2 < patches.length) {
      const patch = patches[i2];
      if (patch.type === "replace") {
        i2 += 1;
        continue;
      }
      if (patch.type === "update") {
        let runEnd = i2 + 1;
        while (runEnd < patches.length && patches[runEnd].type === "update") {
          runEnd += 1;
        }
        const runLen = runEnd - i2;
        if (runLen === 1) {
          applySingleUpdate(liveParent, items, patch);
        } else {
          applyBulkUpdate(liveParent, items, patches, i2, runEnd);
        }
        i2 = runEnd;
        continue;
      }
      if (patch.type === "insert") {
        let runEnd = i2 + 1;
        while (runEnd < patches.length && patches[runEnd].type === "insert" && patches[runEnd].index === patches[runEnd - 1].index + 1) {
          runEnd += 1;
        }
        const runLen = runEnd - i2;
        if (runLen === 1) {
          applySingleInsert(liveParent, items, patch, endAnchor(binding));
        } else {
          applyBulkInsert(liveParent, items, patches, i2, runEnd, endAnchor(binding));
        }
        i2 = runEnd;
        continue;
      }
      if (patch.type === "remove") {
        const entry = items[patch.index];
        liveParent.removeChild(entry.node);
        items.splice(patch.index, 1);
        i2 += 1;
        continue;
      }
      if (patch.type === "move") {
        const moved = items[patch.from];
        let anchorIdx = patch.to;
        if (patch.from < patch.to) anchorIdx += 1;
        const anchor = anchorIdx < items.length ? items[anchorIdx].node : endAnchor(binding);
        liveParent.insertBefore(moved.node, anchor);
        items.splice(patch.from, 1);
        items.splice(patch.to, 0, moved);
        i2 += 1;
        continue;
      }
    }
    if (focusSnap !== null) restoreFocus(focusSnap);
    if (items.length > 0) {
      maybeWarnMissingRowKey(items[0].node, 0, items[0].html, binding);
    }
  }
  function applySingleInsert(liveParent, items, patch, tailAnchor) {
    const { html } = patch;
    const newNode = parseSingleRow(html);
    const anchor = patch.index < items.length ? items[patch.index].node : tailAnchor;
    liveParent.insertBefore(newNode, anchor);
    items.splice(patch.index, 0, {
      ref: patch.item,
      cacheKey: void 0,
      html,
      node: newNode
    });
  }
  function applySingleUpdate(liveParent, items, patch) {
    const { html } = patch;
    const oldEntry = items[patch.index];
    if (html === oldEntry.html) return;
    if (tryAttributeOnlyFastPath(oldEntry.node, oldEntry.html, html) || tryTextContentFastPath(oldEntry.node, oldEntry.html, html)) {
      items[patch.index] = { ref: patch.item, cacheKey: void 0, html, node: oldEntry.node };
      return;
    }
    const newNode = parseSingleRow(html);
    if (oldEntry.node.tagName === newNode.tagName) {
      _morphElement(oldEntry.node, newNode);
      items[patch.index] = { ref: patch.item, cacheKey: void 0, html, node: oldEntry.node };
    } else {
      liveParent.replaceChild(newNode, oldEntry.node);
      items[patch.index] = { ref: patch.item, cacheKey: void 0, html, node: newNode };
    }
  }
  function applyBulkUpdate(liveParent, items, patches, start, end) {
    const morphChanges = [];
    for (let k = start; k < end; k++) {
      const p2 = patches[k];
      const oldEntry = items[p2.index];
      if (p2.html === oldEntry.html) continue;
      if (tryAttributeOnlyFastPath(oldEntry.node, oldEntry.html, p2.html) || tryTextContentFastPath(oldEntry.node, oldEntry.html, p2.html)) {
        items[p2.index] = { ref: p2.item, cacheKey: void 0, html: p2.html, node: oldEntry.node };
        continue;
      }
      morphChanges.push({ patchIdx: k, html: p2.html });
    }
    if (morphChanges.length === 0) return;
    const { tpl, count } = parseRowTemplate(morphChanges.map((c2) => c2.html).join(""));
    if (count !== morphChanges.length) {
      throw findOffendingChange(patches, morphChanges);
    }
    const newNodes = new Array(morphChanges.length);
    let child = tpl.content.firstElementChild;
    for (let k = 0; k < newNodes.length; k++) {
      newNodes[k] = child;
      child = child.nextElementSibling;
    }
    for (let k = 0; k < morphChanges.length; k++) {
      const c2 = morphChanges[k];
      const p2 = patches[c2.patchIdx];
      const oldEntry = items[p2.index];
      if (oldEntry.node.tagName === newNodes[k].tagName) {
        _morphElement(oldEntry.node, newNodes[k]);
        items[p2.index] = { ref: p2.item, cacheKey: void 0, html: c2.html, node: oldEntry.node };
      } else {
        liveParent.replaceChild(newNodes[k], oldEntry.node);
        items[p2.index] = { ref: p2.item, cacheKey: void 0, html: c2.html, node: newNodes[k] };
      }
    }
  }
  function applyBulkInsert(liveParent, items, patches, start, end, tailAnchor) {
    const startIdx = patches[start].index;
    const htmls = new Array(end - start);
    for (let k = start; k < end; k++) {
      const p2 = patches[k];
      htmls[k - start] = p2.html;
    }
    const { tpl, count } = parseRowTemplate(htmls.join(""));
    if (count !== htmls.length) {
      throw findOffendingInsert(patches, start, htmls);
    }
    const newNodes = new Array(end - start);
    let child = tpl.content.firstElementChild;
    for (let k = 0; k < newNodes.length; k++) {
      newNodes[k] = child;
      child = child.nextElementSibling;
    }
    const anchor = startIdx < items.length ? items[startIdx].node : tailAnchor;
    liveParent.insertBefore(tpl.content, anchor);
    const newEntries = new Array(end - start);
    for (let k = 0; k < newEntries.length; k++) {
      const p2 = patches[start + k];
      newEntries[k] = {
        ref: p2.item,
        cacheKey: void 0,
        html: htmls[k],
        node: newNodes[k]
      };
    }
    items.splice(startIdx, 0, ...newEntries);
  }
  function parseSingleRow(html) {
    const { tpl, count } = parseRowTemplate(html);
    if (count !== 1) {
      const reason = count === 0 ? "produced no top-level element" : `produced ${count} top-level elements; exactly one is required`;
      throw new Error(
        `each() granular reconcile: row render ${reason}. Each item's render must return exactly one element. Got HTML: ${JSON.stringify(truncateRowHtml(html))}`
      );
    }
    return tpl.content.firstElementChild;
  }
  function findOffendingInsert(patches, start, htmls) {
    for (let i2 = 0; i2 < htmls.length; i2++) {
      if (parseRowTemplate(htmls[i2]).count !== 1) {
        const p2 = patches[start + i2];
        return rowContractError(p2.index, htmls[i2]);
      }
    }
    return new Error("each(): bulk-insert mismatch with no per-row offender (kerf bug).");
  }
  function findOffendingChange(patches, changes) {
    for (const c2 of changes) {
      if (parseRowTemplate(c2.html).count !== 1) {
        const p2 = patches[c2.patchIdx];
        return rowContractError(p2.index, c2.html);
      }
    }
    return new Error("each(): bulk-update mismatch with no per-row offender (kerf bug).");
  }
  function tryInPlaceContentUpdate(binding, listSeg) {
    const oldItems = binding.items;
    const items = listSeg.items;
    const n2 = items.length;
    if (n2 === 0 || n2 !== oldItems.length) return false;
    for (let i2 = 0; i2 < n2; i2++) {
      if (items[i2].ref !== oldItems[i2].ref) return false;
    }
    const { liveParent } = binding;
    const newRecord = new Array(n2);
    const focusSnap = captureFocus(liveParent);
    for (let i2 = 0; i2 < n2; i2++) {
      newRecord[i2] = updateRowInPlace(liveParent, oldItems[i2], items[i2], i2);
    }
    if (focusSnap !== null) restoreFocus(focusSnap);
    binding.items = newRecord;
    maybeWarnMissingRowKey(newRecord[0].node, 0, newRecord[0].html, binding);
    return true;
  }
  function updateRowInPlace(liveParent, old, ni, index) {
    if (old.html === ni.html || tryAttributeOnlyFastPath(old.node, old.html, ni.html) || tryTextContentFastPath(old.node, old.html, ni.html)) {
      return { ref: ni.ref, cacheKey: ni.cacheKey, html: ni.html, node: old.node };
    }
    const newNode = parseSingleRow2(ni.html, index);
    if (old.node.tagName === newNode.tagName) {
      _morphElement(old.node, newNode);
      return { ref: ni.ref, cacheKey: ni.cacheKey, html: ni.html, node: old.node };
    }
    liveParent.replaceChild(newNode, old.node);
    return { ref: ni.ref, cacheKey: ni.cacheKey, html: ni.html, node: newNode };
  }
  function parseSingleRow2(html, index) {
    const { tpl, count } = parseRowTemplate(html);
    if (count !== 1) throw rowContractError(index, html);
    return tpl.content.firstElementChild;
  }
  function reconcileSnapshot(binding, listSeg) {
    if (tryInPlaceContentUpdate(binding, listSeg)) return;
    const { liveParent } = binding;
    const { newRecord, prevIdx, replacedNodes, freshIndices, freshHtmls } = classifyItems(binding.items, listSeg);
    const tailAnchor = endAnchor(binding);
    buildFreshNodes(newRecord, freshIndices, freshHtmls);
    const focusSnap = captureFocus(liveParent);
    removeOldNodes(liveParent, replacedNodes);
    applyMoves(liveParent, newRecord, prevIdx, lis(prevIdx), tailAnchor);
    if (focusSnap !== null) restoreFocus(focusSnap);
    binding.items = newRecord;
    if (newRecord.length > 0) {
      maybeWarnMissingRowKey(newRecord[0].node, 0, newRecord[0].html, binding);
    }
  }
  function classifyItems(oldItems, listSeg) {
    const oldByRef = /* @__PURE__ */ new Map();
    for (let i2 = 0; i2 < oldItems.length; i2++) {
      oldByRef.set(oldItems[i2].ref, [oldItems[i2], i2]);
    }
    const newRecord = new Array(listSeg.items.length);
    const prevIdx = new Array(listSeg.items.length);
    const replacedNodes = [];
    const freshIndices = [];
    const freshHtmls = [];
    for (let i2 = 0; i2 < listSeg.items.length; i2++) {
      const ni = listSeg.items[i2];
      const oi = oldByRef.get(ni.ref);
      if (oi !== void 0) {
        oldByRef.delete(ni.ref);
        if (oi[0].html === ni.html) {
          newRecord[i2] = oi[0];
          prevIdx[i2] = oi[1];
          continue;
        }
        replacedNodes.push(oi[0].node);
      }
      newRecord[i2] = {
        ref: ni.ref,
        cacheKey: ni.cacheKey,
        html: ni.html,
        node: null
      };
      prevIdx[i2] = -1;
      freshIndices.push(i2);
      freshHtmls.push(ni.html);
    }
    for (const [, orphan] of oldByRef) replacedNodes.push(orphan[0].node);
    return { newRecord, prevIdx, replacedNodes, freshIndices, freshHtmls };
  }
  function buildFreshNodes(newRecord, freshIndices, freshHtmls) {
    if (freshHtmls.length === 0) return;
    const { tpl, count } = parseRowTemplate(freshHtmls.join(""));
    if (count !== freshHtmls.length) {
      throw findOffendingRow(newRecord, freshIndices, freshHtmls);
    }
    let node = tpl.content.firstElementChild;
    for (const idx of freshIndices) {
      const next = node.nextElementSibling;
      newRecord[idx].node = node;
      node = next;
    }
  }
  function findOffendingRow(newRecord, freshIndices, freshHtmls) {
    for (let i2 = 0; i2 < freshHtmls.length; i2++) {
      if (parseRowTemplate(freshHtmls[i2]).count !== 1) {
        return rowContractError(freshIndices[i2], newRecord[freshIndices[i2]].html);
      }
    }
    return new Error("each(): bulk-parse mismatch with no per-row offender (kerf bug).");
  }
  function removeOldNodes(liveParent, replacedNodes) {
    for (const node of replacedNodes) {
      if (node.parentElement === liveParent) liveParent.removeChild(node);
    }
  }
  function applyMoves(liveParent, newRecord, prevIdx, stable, tailAnchor) {
    let nextSibling = tailAnchor;
    for (let i2 = newRecord.length - 1; i2 >= 0; i2--) {
      const node = newRecord[i2].node;
      if (prevIdx[i2] === -1 || !stable.has(i2)) {
        liveParent.insertBefore(node, nextSibling);
      }
      nextSibling = node;
    }
  }
  function lis(arr) {
    const tails = [];
    const tailIdx = [];
    const prev = new Array(arr.length);
    for (let i2 = 0; i2 < arr.length; i2++) {
      const v2 = arr[i2];
      if (v2 === -1) {
        prev[i2] = -1;
        continue;
      }
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (tails[mid] < v2) lo = mid + 1;
        else hi = mid;
      }
      prev[i2] = lo > 0 ? tailIdx[lo - 1] : -1;
      tails[lo] = v2;
      tailIdx[lo] = i2;
    }
    const out = /* @__PURE__ */ new Set();
    let k = tailIdx.length > 0 ? tailIdx[tailIdx.length - 1] : -1;
    while (k !== -1) {
      out.add(k);
      k = prev[k];
    }
    return out;
  }
  function reconcileList(binding, listSeg) {
    if (listSeg.patches !== void 0 && binding.items.length > 0) {
      reconcileGranular(binding, listSeg.patches);
      return;
    }
    reconcileSnapshot(binding, listSeg);
  }
  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    return `<${tag}${id}>`;
  }
  function assertNotInsideMountedTree(rootEl) {
    if (rootEl[MOUNTED_MARKER] === true) {
      throw new Error(
        `mount: ${describeEl(rootEl)} is already mounted. Call the disposer returned by the first mount() before mounting again. kerf supports one mount per element \u2014 compose with plain functions that return JSX instead of nesting mounts.`
      );
    }
    let ancestor = rootEl.parentElement;
    while (ancestor !== null) {
      if (ancestor[MOUNTED_MARKER] === true) {
        throw new Error(
          "mount: rootEl is already inside (or contains) a mounted tree. kerf supports one mount per tree \u2014 compose with plain functions that return JSX instead of nesting mounts."
        );
      }
      ancestor = ancestor.parentElement;
    }
    const stack = [];
    for (let i2 = 0; i2 < rootEl.children.length; i2++) stack.push(rootEl.children[i2]);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur[MOUNTED_MARKER] === true) {
        throw new Error(
          "mount: rootEl is already inside (or contains) a mounted tree. kerf supports one mount per tree \u2014 compose with plain functions that return JSX instead of nesting mounts."
        );
      }
      for (let i2 = 0; i2 < cur.children.length; i2++) stack.push(cur.children[i2]);
    }
  }
  function mount(rootEl, render) {
    if (rootEl == null) {
      throw new Error(
        'mount: rootEl is null/undefined \u2014 pass the live element, e.g. mount(document.getElementById("app")!, render). A common cause is a typo in the id or selector that returns null at runtime even though the TypeScript types say HTMLElement.'
      );
    }
    const owner = rootEl.ownerDocument;
    if (owner !== document) {
      if (owner.defaultView === null) document.adoptNode(rootEl);
    }
    assertNotInsideMountedTree(rootEl);
    rootEl[MOUNTED_MARKER] = true;
    const listenerWarnObserver = installListenerRebuildWarn(rootEl);
    const bindings = /* @__PURE__ */ new Map();
    const renderCtx = {
      counter: 0,
      caches: /* @__PURE__ */ new Map(),
      bindingCounts: /* @__PURE__ */ new Map()
    };
    let isFirst = true;
    let prevStaticHtml = "";
    const disposeEffect = effect(() => {
      renderCtx.counter = 0;
      _setRenderContext(renderCtx);
      let result;
      try {
        result = render();
      } finally {
        _setRenderContext(null);
      }
      const segment = isSafeHtml(result) ? result.__segment ?? { kind: "static", html: result.__html } : { kind: "static", html: coerceRenderResult(result) };
      if (isFirst) {
        runFirstRender(rootEl, segment, bindings);
        prevStaticHtml = flattenWithoutListItems(segment);
        isFirst = false;
      } else {
        prevStaticHtml = runSubsequentRender(rootEl, segment, bindings, renderCtx, prevStaticHtml);
      }
      for (const listSeg of collectLists(segment).values()) {
        const binding = bindings.get(listSeg.id);
        reconcileList(binding, listSeg);
        renderCtx.bindingCounts.set(listSeg.id, binding.items.length);
      }
    });
    return () => {
      disposeEffect();
      listenerWarnObserver?.disconnect();
      delete rootEl[MOUNTED_MARKER];
    };
  }
  function runFirstRender(rootEl, segment, bindings) {
    rootEl.innerHTML = flatten(segment, true);
    bindListsFromMarkers(rootEl, segment, bindings, true);
  }
  function runSubsequentRender(rootEl, segment, bindings, renderCtx, prevStaticHtml) {
    const currentStaticHtml = flattenWithoutListItems(segment);
    if (currentStaticHtml === prevStaticHtml) {
      return prevStaticHtml;
    }
    cleanupOrphanBindings(segment, bindings, renderCtx);
    const template = rootEl.cloneNode(false);
    template.innerHTML = currentStaticHtml;
    morph(rootEl, template, collectOwnedItems(bindings));
    bindListsFromMarkers(rootEl, segment, bindings, false);
    return currentStaticHtml;
  }
  function coerceRenderResult(result) {
    if (result === null || result === void 0) return "";
    if (result === false || result === true) return "";
    return String(result);
  }
  function bindListsFromMarkers(rootEl, segment, bindings, inlinedItems) {
    const lists = collectLists(segment);
    const found = [];
    collectComments(rootEl, found);
    for (const marker of found) {
      if (!marker.data.startsWith(LIST_MARKER_PREFIX)) continue;
      const id = marker.data.slice(LIST_MARKER_PREFIX.length);
      if (bindings.has(id)) continue;
      const listSeg = lists.get(id);
      const liveParent = marker.parentElement;
      const items = [];
      if (inlinedItems) {
        let next = marker.nextElementSibling;
        for (let i2 = 0; i2 < listSeg.items.length && next !== null; i2++) {
          validateInlinedRowMatch(listSeg.items[i2].html, i2, next);
          items.push({
            ref: listSeg.items[i2].ref,
            cacheKey: listSeg.items[i2].cacheKey,
            html: listSeg.items[i2].html,
            node: next
          });
          next = next.nextElementSibling;
        }
      }
      const binding = { liveParent, items, marker };
      if (items.length > 0) {
        maybeWarnMissingRowKey(items[0].node, 0, items[0].html, binding);
      }
      maybeWarnEachInMorphSkip(id, liveParent, rootEl);
      bindings.set(id, binding);
    }
  }
  function validateInlinedRowMatch(expectedHtml, index, boundEl) {
    if (boundEl.outerHTML === expectedHtml) return;
    const { count } = parseRowTemplate(expectedHtml);
    if (count === 1) return;
    throw rowContractError(index, expectedHtml);
  }
  function collectOwnedItems(bindings) {
    const owned = /* @__PURE__ */ new Set();
    for (const b2 of bindings.values()) {
      for (const item of b2.items) owned.add(item.node);
    }
    return owned;
  }
  function cleanupOrphanBindings(segment, bindings, renderCtx) {
    const liveIds = collectLists(segment);
    for (const [id, binding] of bindings) {
      if (liveIds.has(id)) continue;
      for (const item of binding.items) {
        if (item.node.parentElement !== null) {
          item.node.parentElement.removeChild(item.node);
        }
      }
      if (binding.marker.parentElement !== null) {
        binding.marker.parentElement.removeChild(binding.marker);
      }
      bindings.delete(id);
      renderCtx.bindingCounts.delete(id);
      renderCtx.caches.delete(id);
    }
  }
  function collectComments(node, out) {
    for (let c2 = node.firstChild; c2 !== null; c2 = c2.nextSibling) {
      if (c2.nodeType === Node.COMMENT_NODE) out.push(c2);
      else if (c2.nodeType === Node.ELEMENT_NODE) collectComments(c2, out);
    }
  }
  var NON_BUBBLING, warnedIds, warnedDupIds, ARRAY_SIGNAL_BRAND, context, ID_KEY_PREFIX, DATA_KEY_PREFIX, ELEMENT_NODE, TEXT_NODE, COMMENT_NODE, EMPTY_OWNED, LISTENER_MARKER, patched, warned2, LT, GT, DQUOTE, SQUOTE, AMP, EQ, SLASH, TEXT_NODE2, ELEMENT_NODE2, ROW_HTML_SNIPPET_MAX, LIST_MARKER_PREFIX, MOUNTED_MARKER;
  var init_dist = __esm({
    "node_modules/kerfjs/dist/index.js"() {
      init_chunk_4VT4YZOO();
      init_chunk_N4KF3GD2();
      init_chunk_N4KF3GD2();
      NON_BUBBLING = /* @__PURE__ */ new Set([
        "focus",
        "blur",
        "scroll",
        "load",
        "error",
        "mouseenter",
        "mouseleave"
      ]);
      warnedIds = /* @__PURE__ */ new Set();
      warnedDupIds = /* @__PURE__ */ new Set();
      ARRAY_SIGNAL_BRAND = /* @__PURE__ */ Symbol.for("kerfjs.ArraySignal");
      context = null;
      ID_KEY_PREFIX = "id:";
      DATA_KEY_PREFIX = "data-key:";
      ELEMENT_NODE = 1;
      TEXT_NODE = 3;
      COMMENT_NODE = 8;
      EMPTY_OWNED = /* @__PURE__ */ new Set();
      LISTENER_MARKER = /* @__PURE__ */ Symbol.for("kerfjs.devListener");
      patched = false;
      warned2 = false;
      LT = 60;
      GT = 62;
      DQUOTE = 34;
      SQUOTE = 39;
      AMP = 38;
      EQ = 61;
      SLASH = 47;
      TEXT_NODE2 = 3;
      ELEMENT_NODE2 = 1;
      ROW_HTML_SNIPPET_MAX = 120;
      LIST_MARKER_PREFIX = "kf-list:";
      MOUNTED_MARKER = /* @__PURE__ */ Symbol.for("kerfjs.mounted");
    }
  });

  // ui/kerf.ts
  var init_kerf = __esm({
    "ui/kerf.ts"() {
      "use strict";
      init_dist();
    }
  });

  // node_modules/kerfjs/dist/jsx-runtime.js
  var init_jsx_runtime = __esm({
    "node_modules/kerfjs/dist/jsx-runtime.js"() {
      init_chunk_4VT4YZOO();
    }
  });

  // ui/desktop-app.tsx
  function displayState(stage, selected) {
    if (stage.state === "locked") return "locked";
    if (stage.key === selected) return "active";
    return stage.state === "done" ? "done" : "idle";
  }
  function cutKindFromPrompt(prompt) {
    const value = prompt.toLowerCase();
    if (/\bfull\b|whole|entire/.test(value)) return "full";
    if (/teaser/.test(value)) return "teaser";
    if (/trailer/.test(value)) return "trailer";
    if (/summary|recap/.test(value)) return "summary";
    if (/soundbite|quote/.test(value)) return "soundbites";
    if (/sizzle/.test(value)) return "sizzle";
    return "highlights";
  }
  function buildAutoPrompt(prompt, snapshot) {
    const multicam = snapshot.project.artifacts.includes("multicam");
    const schema = multicam ? '{ "switches": [ { "atSeconds": 0, "memberId": "<angle id from multicam.json>" } ], "rationale": "<one line>" }\n(read multicam.json in the project folder for the angle memberIds; use only real ids)' : '{ "clips": [ { "in": <startSeconds>, "out": <endSeconds> } ], "rationale": "<one line>" }\n(pick scene ranges from the single video; in/out are seconds, out > in)';
    return `${prompt}

(Project folder: ${snapshot.folder})

When you've decided the edit, END your reply with the cut plan as a \`\`\`json code block matching this schema:
\`\`\`json
${schema}
\`\`\``;
  }
  function Header({ title, sub }) {
    return /* @__PURE__ */ jsx("header", { class: "screen-head", children: [
      /* @__PURE__ */ jsx("h1", { children: title }),
      /* @__PURE__ */ jsx("p", { class: "sub", children: sub })
    ] });
  }
  function Rail() {
    return /* @__PURE__ */ jsx("nav", { class: "rail", "aria-label": "Pipeline stages", children: [
      /* @__PURE__ */ jsx("div", { class: "rail-stages", children: each(stages.value.map((stage) => ({ ...stage })), (stage) => /* @__PURE__ */ jsx("button", { class: "stage", "data-key": stage.key, "data-stage": stage.key, "data-state": displayState(stage, screen.value), disabled: displayState(stage, screen.value) === "locked", ...ACTIONS.stage.attrs, children: stage.label })) }),
      /* @__PURE__ */ jsx("button", { class: "rail-settings", ...ACTIONS.permissions.attrs, children: "Permissions" })
    ] });
  }
  function Setup() {
    return /* @__PURE__ */ jsx("section", { class: "screen", "data-screen": "setup", hidden: screen.value !== "setup", children: [
      /* @__PURE__ */ jsx(Header, { title: "Setup", sub: "video-studio runs external tools. This checks what's installed \u2014 nothing is assumed." }),
      /* @__PURE__ */ jsx("button", { class: "btn", ...ACTIONS.doctor.attrs, children: "Check tools" }),
      /* @__PURE__ */ jsx("ul", { class: "doctor", children: [
        doctorStatus.value ? /* @__PURE__ */ jsx("li", { class: "doctor-row", children: doctorStatus.value }) : "",
        each(doctorRows.value, (row, index) => /* @__PURE__ */ jsx("li", { class: `doctor-row ${row.status}`, "data-key": `${row.label}-${index}`, children: [
          /* @__PURE__ */ jsx("span", { class: "dot", children: row.found ? "\u25CF" : "\u25CB" }),
          /* @__PURE__ */ jsx("span", { class: "name", children: row.label }),
          /* @__PURE__ */ jsx("span", { class: "tag", children: row.required ? "required" : "optional" }),
          row.found ? "" : /* @__PURE__ */ jsx("span", { class: "hint", children: row.hint || "" })
        ] }))
      ] })
    ] });
  }
  function NewProject() {
    const snap = project.value;
    const imported = Boolean(snap?.project.artifacts.some((a2) => a2 === "sources" || a2 === "multicam"));
    const artifactItems = each((snap?.project.artifacts || []).map((name) => ({ name })), (item) => /* @__PURE__ */ jsx("li", { class: "artifact", "data-key": item.name, children: item.name }));
    const recentItems = each(recents.value.map((folder) => ({ folder })), (item) => /* @__PURE__ */ jsx("button", { class: "recent-project", "data-key": item.folder, "data-folder": item.folder, ...ACTIONS.recent.attrs, children: [
      /* @__PURE__ */ jsx("span", { class: "recent-name", children: item.folder.split("/").filter(Boolean).at(-1) || item.folder }),
      /* @__PURE__ */ jsx("span", { class: "recent-path", children: item.folder })
    ] }));
    return /* @__PURE__ */ jsx("section", { class: "screen", "data-screen": "new-project", hidden: screen.value !== "new-project", children: [
      /* @__PURE__ */ jsx(Header, { title: "New Project", sub: "Open a folder of footage. The filesystem is the source of truth." }),
      /* @__PURE__ */ jsx("div", { class: "row", children: [
        /* @__PURE__ */ jsx("button", { class: "btn", ...ACTIONS.openProject.attrs, children: "Open project folder\u2026" }),
        /* @__PURE__ */ jsx("button", { class: "btn", ...ACTIONS.createProject.attrs, children: "Create here\u2026" })
      ] }),
      recents.value.length ? /* @__PURE__ */ jsx("div", { class: "recent-projects", children: [
        /* @__PURE__ */ jsx("h2", { children: "Recent projects" }),
        /* @__PURE__ */ jsx("div", { class: "recent-list", children: recentItems })
      ] }) : "",
      snap ? /* @__PURE__ */ jsx("div", { class: "project-info", children: [
        /* @__PURE__ */ jsx("div", { class: "project-name", children: snap.project.name }),
        /* @__PURE__ */ jsx("div", { class: "project-folder", children: snap.folder }),
        /* @__PURE__ */ jsx("ul", { class: "artifacts", children: imported ? artifactItems : /* @__PURE__ */ jsx("li", { class: "artifact none", children: "No footage imported yet. Analyze this folder's video(s) to begin." }) }),
        !imported ? /* @__PURE__ */ jsx("div", { class: "import-box", children: [
          /* @__PURE__ */ jsx("button", { class: "btn primary", disabled: importRequest.value !== null, ...ACTIONS.importRun.attrs, children: "Analyze this footage" }),
          importRequest.value !== null ? /* @__PURE__ */ jsx("button", { class: "btn small", ...ACTIONS.importCancel.attrs, children: "Cancel" }) : "",
          /* @__PURE__ */ jsx("div", { class: "import-status", children: importStatus.value })
        ] }) : ""
      ] }) : ""
    ] });
  }
  function Analyze() {
    const snap = project.value;
    const done = snap?.project.artifacts.includes("audioEvents");
    return /* @__PURE__ */ jsx("section", { class: "screen", "data-screen": "analyze", hidden: screen.value !== "analyze", children: [
      /* @__PURE__ */ jsx(Header, { title: "Analyze", sub: "The deeper pass over your footage \u2014 musical/edit-awareness data the Design step uses." }),
      snap ? /* @__PURE__ */ jsx(Fragment, { children: [
        /* @__PURE__ */ jsx("div", { class: "op-engine", children: "Engine: runs on your machine (ffmpeg + whisper) \u2014 no AI, no cost" }),
        /* @__PURE__ */ jsx("ol", { class: "op-steps", children: /* @__PURE__ */ jsx("li", { class: `op-step${done ? " done" : ""}`, children: "Audio events \u2014 loudness, onsets, quiet, vocal/instrumental sections" }) }),
        /* @__PURE__ */ jsx("div", { class: "row", children: [
          /* @__PURE__ */ jsx("button", { class: "btn primary", disabled: analyzeRequest.value !== null, ...ACTIONS.analyzeRun.attrs, children: done ? "Re-run analysis" : "Run analysis" }),
          analyzeRequest.value !== null ? /* @__PURE__ */ jsx("button", { class: "btn small", ...ACTIONS.analyzeCancel.attrs, children: "Cancel" }) : ""
        ] }),
        analyzeStatus.value ? /* @__PURE__ */ jsx("div", { class: "op-progress", children: [
          /* @__PURE__ */ jsx("div", { class: "op-bar", "data-indeterminate": true, children: /* @__PURE__ */ jsx("div", { class: "op-bar-fill" }) }),
          /* @__PURE__ */ jsx("div", { class: "op-status", children: analyzeStatus.value })
        ] }) : ""
      ] }) : /* @__PURE__ */ jsx("p", { class: "analyze-empty", children: "Import footage first (New Project) \u2014 Analyze needs a project." })
    ] });
  }
  function Design() {
    return /* @__PURE__ */ jsx("section", { class: "screen design-screen", "data-screen": "design", hidden: screen.value !== "design", children: [
      /* @__PURE__ */ jsx(Header, { title: "Design the cut", sub: "Describe the cut you want. Continue to Export or open the timeline for detailed multi-camera edits." }),
      /* @__PURE__ */ jsx("div", { class: "lanes", children: [
        /* @__PURE__ */ jsx("div", { class: "lane", children: [
          /* @__PURE__ */ jsx("div", { class: "lane-title", children: "Auto" }),
          /* @__PURE__ */ jsx("p", { class: "lane-desc", children: "Describe the cut and let an AI agent propose it." }),
          /* @__PURE__ */ jsx("div", { class: "presets", children: each(PRESETS.map(([label, preset]) => ({ label, preset })), (item) => /* @__PURE__ */ jsx("button", { class: "chip", "data-key": item.label, "data-preset": item.preset, ...ACTIONS.preset.attrs, children: item.label })) }),
          /* @__PURE__ */ jsx("textarea", { class: "prompt", ...ACTIONS.designPrompt.attrs, rows: 3, placeholder: "e.g. a punchy 15-second teaser", children: designPrompt.value }),
          /* @__PURE__ */ jsx("button", { class: "btn primary", disabled: designRunning.value, ...ACTIONS.designMake.attrs, children: autoSessionId ? "Refine cut" : "Make my cut" }),
          /* @__PURE__ */ jsx("div", { class: "lane-note", children: designNote.value }),
          /* @__PURE__ */ jsx("ul", { class: "activity-feed", children: each(feed.value, (item) => /* @__PURE__ */ jsx("li", { class: "feed-item", "data-key": item.id, children: [
            /* @__PURE__ */ jsx("span", { class: "feed-label", children: item.label }),
            item.detail ? /* @__PURE__ */ jsx("span", { class: "feed-detail", children: item.detail }) : ""
          ] })) })
        ] }),
        /* @__PURE__ */ jsx("div", { class: "timeline-action", children: [
          /* @__PURE__ */ jsx("p", { class: "lane-desc", children: "Need precise multi-camera changes? Open the timeline to adjust angles and split points." }),
          /* @__PURE__ */ jsx("button", { class: "btn", ...ACTIONS.timeline.attrs, children: "Open timeline editor" }),
          /* @__PURE__ */ jsx("div", { class: "lane-note", children: manualNote.value })
        ] })
      ] }),
      reviewStatus.value ? /* @__PURE__ */ jsx("div", { class: "review-status", children: reviewStatus.value }) : "",
      reviewUrl.value ? /* @__PURE__ */ jsx("iframe", { class: "review-frame", "data-morph-skip": "", src: reviewUrl.value, title: "Review UI" }) : ""
    ] });
  }
  function fmtTime(seconds) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }
  function ExportPreview() {
    const cues = each(audioMap.value, (cue, index) => /* @__PURE__ */ jsx("li", { "data-key": `${cue.startSeconds}-${cue.kind}-${index}`, children: /* @__PURE__ */ jsx("button", { "data-seconds": cue.startSeconds, ...ACTIONS.previewCue.attrs, children: [
      /* @__PURE__ */ jsx("time", { children: fmtTime(cue.startSeconds) }),
      /* @__PURE__ */ jsx("span", { class: `audio-kind ${cue.kind}`, children: cue.kind }),
      /* @__PURE__ */ jsx("span", { children: cue.text })
    ] }) }));
    return /* @__PURE__ */ jsx("div", { class: "export-preview", children: [
      /* @__PURE__ */ jsx("h2", { children: "Cut preview" }),
      previewUrl.value ? /* @__PURE__ */ jsx("video", { id: "export-preview-video", "data-morph-skip": "", src: previewUrl.value, controls: true, preload: "metadata" }) : /* @__PURE__ */ jsx("div", { class: "preview-status", children: previewStatus.value || "Preparing a lightweight preview\u2026" }),
      previewStatus.value && !previewUrl.value ? /* @__PURE__ */ jsx("button", { class: "btn small", ...ACTIONS.retryPreview.attrs, children: "Retry preview" }) : "",
      /* @__PURE__ */ jsx("h3", { children: "Post-edit audio map" }),
      audioMap.value.length ? /* @__PURE__ */ jsx("ol", { class: "preview-transcript", children: cues }) : /* @__PURE__ */ jsx("p", { class: "sub", children: "No speech/audio analysis is available for this cut yet." })
    ] });
  }
  function ExportScreen() {
    return /* @__PURE__ */ jsx("section", { class: "screen", "data-screen": "export", hidden: screen.value !== "export", children: [
      /* @__PURE__ */ jsx(Header, { title: "Export", sub: "Turn your designed cut into a finished file. Open a project first." }),
      /* @__PURE__ */ jsx(ExportPreview, {}),
      /* @__PURE__ */ jsx("div", { class: "export-cards", children: each(EXPORTS.map((item) => ({ ...item })), (item) => {
        const state = exportsState.value[item.kind] ?? { status: "ready", running: false };
        return /* @__PURE__ */ jsx("div", { class: "export-card", "data-key": item.kind, "data-kind": item.kind, children: [
          /* @__PURE__ */ jsx("div", { class: "export-title", children: item.title }),
          /* @__PURE__ */ jsx("div", { class: "export-desc", children: item.desc }),
          /* @__PURE__ */ jsx("button", { class: "btn export-run", disabled: state.running, ...ACTIONS.exportRun.attrs, children: "Export" }),
          state.running ? /* @__PURE__ */ jsx("button", { class: "btn small export-cancel", ...ACTIONS.exportCancel.attrs, children: "Cancel" }) : "",
          /* @__PURE__ */ jsx("div", { class: "export-status", children: state.status }),
          state.outPath ? /* @__PURE__ */ jsx("button", { class: "btn small export-reveal", "data-path": state.outPath, ...ACTIONS.reveal.attrs, children: "Reveal in Finder" }) : ""
        ] });
      }) })
    ] });
  }
  function Permissions() {
    const policy = config.value.policy || {};
    const rules = config.value.rules || [];
    return /* @__PURE__ */ jsx("section", { class: "screen", "data-screen": "permissions", hidden: screen.value !== "permissions", children: [
      /* @__PURE__ */ jsx(Header, { title: "Permissions", sub: "Choose what the AI agent may do silently versus what requires approval." }),
      /* @__PURE__ */ jsx("ul", { class: "perm-toggles", children: each(PERMISSIONS.map(([key, label, desc, def, toggle]) => ({ key, label, desc, def, toggle })), (item) => {
        const allowed = (policy[item.key] ?? item.def) === "allow";
        return /* @__PURE__ */ jsx("li", { class: "perm-toggle", "data-key": item.key, children: [
          /* @__PURE__ */ jsx("div", { class: "perm-text", children: [
            /* @__PURE__ */ jsx("div", { class: "perm-label", children: item.label }),
            /* @__PURE__ */ jsx("div", { class: "perm-desc", children: item.desc })
          ] }),
          /* @__PURE__ */ jsx("label", { class: "perm-switch", children: [
            /* @__PURE__ */ jsx("input", { type: "checkbox", "data-category": item.key, checked: allowed, disabled: !item.toggle, ...ACTIONS.policy.attrs }),
            /* @__PURE__ */ jsx("span", { class: "perm-state", children: allowed ? "allowed" : "asks" })
          ] })
        ] });
      }) }),
      /* @__PURE__ */ jsx("h2", { class: "perm-subhead", children: "Remembered approvals" }),
      rules.length ? /* @__PURE__ */ jsx("ul", { class: "perm-rules", children: each(rules, (rule, index) => /* @__PURE__ */ jsx("li", { class: "perm-rule", "data-key": `${rule.category}-${index}`, children: [
        /* @__PURE__ */ jsx("span", { class: "perm-rule-text", children: [
          rule.decision === "deny" ? "Never" : "Always",
          " allow ",
          /* @__PURE__ */ jsx("b", { children: rule.category }),
          " (",
          rule.scope === "project" ? "this project" : "everywhere",
          ")"
        ] }),
        /* @__PURE__ */ jsx("button", { class: "btn small", "data-index": index, ...ACTIONS.revoke.attrs, children: "Revoke" })
      ] })) }) : /* @__PURE__ */ jsx("p", { class: "sub", children: "No remembered rules yet." }),
      rules.length ? /* @__PURE__ */ jsx("button", { class: "btn", ...ACTIONS.resetRules.attrs, children: "Reset all remembered approvals" }) : ""
    ] });
  }
  function InteractionDialog() {
    const active = activeInteraction.value;
    if (!active) return /* @__PURE__ */ jsx("dialog", { id: "interaction-dialog" });
    const interaction = active.interaction;
    const questions = interaction.payload?.questions || [];
    return /* @__PURE__ */ jsx("dialog", { id: "interaction-dialog", children: /* @__PURE__ */ jsx("form", { method: "dialog", children: [
      /* @__PURE__ */ jsx("h2", { children: interaction.kind === "permission" ? interaction.title || "Approval needed" : "The editor needs your input" }),
      /* @__PURE__ */ jsx("p", { class: "sub", children: interaction.kind === "permission" ? interaction.description || "" : "Choose an answer so the cut can continue." }),
      interaction.kind === "permission" ? /* @__PURE__ */ jsx("pre", { class: "interaction-detail", children: [
        interaction.toolName,
        " \xB7 ",
        interaction.category,
        "\n",
        JSON.stringify(interaction.input, null, 2)
      ] }) : /* @__PURE__ */ jsx("div", { class: "interaction-questions", children: each(questions, (question, index) => /* @__PURE__ */ jsx("fieldset", { class: "interaction-question", "data-key": index, children: [
        /* @__PURE__ */ jsx("legend", { children: question.question || question.header || `Question ${index + 1}` }),
        each((question.options || []).map((option) => ({ ...option })), (option) => /* @__PURE__ */ jsx("label", { class: "interaction-option", "data-key": option.label, children: [
          /* @__PURE__ */ jsx("input", { type: question.multiSelect ? "checkbox" : "radio", name: `question-${index}`, value: option.label }),
          " ",
          option.label,
          option.description ? /* @__PURE__ */ jsx("span", { children: option.description }) : ""
        ] }))
      ] })) }),
      /* @__PURE__ */ jsx("div", { class: "interaction-actions", children: interaction.kind === "permission" ? /* @__PURE__ */ jsx(Fragment, { children: [
        /* @__PURE__ */ jsx("button", { class: "btn", value: "deny", ...ACTIONS.interaction.attrs, children: "Deny" }),
        /* @__PURE__ */ jsx("button", { class: "btn", value: "always-allow", ...ACTIONS.interaction.attrs, children: "Always allow this kind" }),
        /* @__PURE__ */ jsx("button", { class: "btn primary", value: "allow-once", ...ACTIONS.interaction.attrs, children: "Allow once" })
      ] }) : /* @__PURE__ */ jsx(Fragment, { children: [
        /* @__PURE__ */ jsx("button", { class: "btn", value: "cancelled", ...ACTIONS.interaction.attrs, children: "Cancel" }),
        /* @__PURE__ */ jsx("button", { class: "btn primary", value: "completed", ...ACTIONS.interaction.attrs, children: "Continue" })
      ] }) })
    ] }) });
  }
  function DesktopApp() {
    return /* @__PURE__ */ jsx("div", { class: "app", "data-ui-runtime": "kerfjs", children: [
      /* @__PURE__ */ jsx(Rail, {}),
      /* @__PURE__ */ jsx("main", { class: "panel", children: [
        /* @__PURE__ */ jsx(Setup, {}),
        /* @__PURE__ */ jsx(NewProject, {}),
        /* @__PURE__ */ jsx(Analyze, {}),
        /* @__PURE__ */ jsx(Design, {}),
        /* @__PURE__ */ jsx(ExportScreen, {}),
        /* @__PURE__ */ jsx(Permissions, {})
      ] }),
      /* @__PURE__ */ jsx(InteractionDialog, {})
    ] });
  }
  function send(step, params, handlers = {}) {
    const id = nextId++;
    pending.set(id, handlers);
    void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "request", id, step, params }) });
    return id;
  }
  function cancel(id) {
    void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "cancel", id }) });
  }
  function answerInteraction(interactionId, decision, value) {
    void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "interaction-response", interactionId, decision, value }) });
  }
  function showNextInteraction() {
    if (!activeInteraction.value && interactionQueue.length) {
      activeInteraction.value = interactionQueue.shift() ?? null;
      queueMicrotask(() => {
        const dialog = document.getElementById("interaction-dialog");
        if (dialog && !dialog.open) dialog.showModal();
      });
    }
  }
  function applySnapshot(snapshot) {
    if (project.value?.folder !== snapshot.folder) autoSessionId = null;
    project.value = snapshot;
    stages.value = snapshot.stages;
  }
  function loadConfig() {
    send("config-get", {}, { onResult: (data) => {
      config.value = data;
      recents.value = data.recentProjects || [];
    } });
  }
  function refresh(callback) {
    const snap = project.value;
    if (!snap) return;
    send("project-open", { folder: snap.folder }, { onResult: (data) => {
      applySnapshot(data);
      callback?.();
    } });
  }
  function goto(key) {
    const previous = screen.value;
    screen.value = key;
    if (key === "permissions") loadConfig();
    if (key === "export" && previous !== "export") {
      previewFolder = "";
      loadExportPreview();
    }
  }
  function openFolder(step) {
    void getTauri().core.invoke("open_folder").then((folder) => {
      if (typeof folder !== "string" || !folder) return;
      send(step, { folder }, { onResult: (data) => {
        applySnapshot(data);
        send("config-add-recent", { folder }, { onResult: (next) => {
          config.value = next;
          recents.value = next.recentProjects || [];
        } });
      }, onError: (error) => {
        importStatus.value = error.message;
      } });
    });
  }
  function updateExport(kind, patch) {
    const current = exportsState.value[kind] ?? { status: "ready", running: false };
    exportsState.value = { ...exportsState.value, [kind]: { ...current, ...patch } };
  }
  function listenSidecar() {
    void getTauri().event.listen("sidecar", (event) => {
      let message;
      try {
        message = JSON.parse(event.payload);
      } catch {
        return;
      }
      if (message.type === "ready") return;
      if (message.type === "interaction-request" && message.interactionId && message.interaction) {
        interactionQueue.push({ interactionId: message.interactionId, interaction: message.interaction });
        showNextInteraction();
        return;
      }
      if (message.id === void 0) return;
      const handlers = pending.get(message.id);
      if (!handlers) return;
      if (message.type === "progress" && message.progress) handlers.onProgress?.(message.progress);
      else if (message.type === "result") {
        pending.delete(message.id);
        handlers.onResult?.(message.data);
      } else if (message.type === "error" && message.error) {
        pending.delete(message.id);
        handlers.onError?.(message.error);
      }
    });
  }
  function bootDesktop(root) {
    listenSidecar();
    mount(root, DesktopApp);
    void delegate(root, "click", ACTIONS.stage.selector, (_event, el) => {
      const key = el.dataset.stage;
      if (displayState(stages.value.find((item) => item.key === key) ?? defaultStages[0], screen.value) !== "locked") goto(key);
    });
    void delegate(root, "click", ACTIONS.permissions.selector, () => goto("permissions"));
    void delegate(root, "click", ACTIONS.doctor.selector, () => {
      doctorStatus.value = "Checking\u2026";
      doctorRows.value = [];
      send("doctor", {}, { onResult: (data) => {
        doctorStatus.value = "";
        doctorRows.value = data.rows;
      }, onError: (error) => {
        doctorStatus.value = `Error: ${error.message}`;
      } });
    });
    void delegate(root, "click", ACTIONS.openProject.selector, () => openFolder("project-open"));
    void delegate(root, "click", ACTIONS.createProject.selector, () => openFolder("project-create"));
    void delegate(root, "click", ACTIONS.recent.selector, (_event, el) => {
      const folder = el.dataset.folder;
      if (folder) send("project-open", { folder }, { onResult: applySnapshot, onError: (error) => {
        importStatus.value = error.message;
      } });
    });
    void delegate(root, "click", ACTIONS.importRun.selector, () => {
      const snap = project.value;
      if (!snap) return;
      importStatus.value = "Analyzing footage\u2026";
      importRequest.value = send("import-footage", { folder: snap.folder }, { onProgress: (p2) => {
        if (p2.message) importStatus.value = `Analyzing\u2026 ${p2.message}`.slice(0, 80);
      }, onResult: () => {
        importRequest.value = null;
        refresh(() => goto("analyze"));
      }, onError: (error) => {
        importRequest.value = null;
        importStatus.value = error.message;
      } });
    });
    void delegate(root, "click", ACTIONS.importCancel.selector, () => {
      if (importRequest.value !== null) cancel(importRequest.value);
    });
    void delegate(root, "click", ACTIONS.analyzeRun.selector, () => {
      const snap = project.value;
      if (!snap) return;
      analyzeStatus.value = "Starting\u2026";
      analyzeRequest.value = send("analyze-project", { folder: snap.folder }, { onProgress: (p2) => {
        if (p2.message) analyzeStatus.value = p2.message.slice(0, 90);
      }, onResult: () => {
        analyzeRequest.value = null;
        analyzeStatus.value = "Analysis complete.";
        refresh(() => goto("design"));
      }, onError: (error) => {
        analyzeRequest.value = null;
        analyzeStatus.value = error.message;
      } });
    });
    void delegate(root, "click", ACTIONS.analyzeCancel.selector, () => {
      if (analyzeRequest.value !== null) cancel(analyzeRequest.value);
    });
    void delegate(root, "click", ACTIONS.preset.selector, (_event, el) => {
      designPrompt.value = el.dataset.preset || "";
    });
    void delegate(root, "input", ACTIONS.designPrompt.selector, (_event, el) => {
      designPrompt.value = el.value;
    });
    void delegate(root, "click", ACTIONS.designMake.selector, () => runDesign());
    void delegate(root, "click", ACTIONS.timeline.selector, () => startReview());
    void delegate(root, "click", ACTIONS.exportRun.selector, (_event, el) => runExport(el.closest("[data-kind]")?.dataset.kind || ""));
    void delegate(root, "click", ACTIONS.exportCancel.selector, (_event, el) => {
      const kind = el.closest("[data-kind]")?.dataset.kind;
      const id = kind ? requestByKind.get(kind) : void 0;
      if (id !== void 0) cancel(id);
    });
    void delegate(root, "click", ACTIONS.reveal.selector, (_event, el) => {
      const path = el.dataset.path;
      if (path) void getTauri().core.invoke("reveal_in_finder", { path });
    });
    void delegate(root, "click", ACTIONS.previewCue.selector, (_event, el) => {
      const video = root.querySelector("#export-preview-video");
      if (!video) return;
      video.currentTime = Number(el.dataset.seconds) || 0;
      void video.play().catch(() => void 0);
    });
    void delegate(root, "click", ACTIONS.retryPreview.selector, () => {
      previewFolder = "";
      loadExportPreview();
    });
    void delegate(root, "change", ACTIONS.policy.selector, (_event, el) => {
      const input = el;
      const category = input.dataset.category;
      if (category) send("config-set-policy", { category, decision: input.checked ? "allow" : "ask" }, { onResult: (data) => {
        config.value = data;
      } });
    });
    void delegate(root, "click", ACTIONS.revoke.selector, (_event, el) => {
      const index = Number(el.dataset.index);
      send("config-revoke-rule", { index }, { onResult: (data) => {
        config.value = data;
      } });
    });
    void delegate(root, "click", ACTIONS.resetRules.selector, () => send("config-reset-rules", {}, { onResult: (data) => {
      config.value = data;
    } }));
    void delegate(root, "click", ACTIONS.interaction.selector, (_event, el) => submitInteraction(root, el.value));
    void delegate(root, "cancel", "#interaction-dialog", (event) => {
      event.preventDefault();
      submitInteraction(root, "cancelled");
    });
    loadConfig();
  }
  function runDesign() {
    const snap = project.value;
    const prompt = designPrompt.value.trim();
    if (!snap) {
      designNote.value = "Open a project first (New Project).";
      return;
    }
    if (!prompt) {
      designNote.value = "Describe the cut you want (or pick a preset).";
      return;
    }
    feed.value = [];
    designRunning.value = true;
    designNote.value = autoSessionId ? "Refining your cut\u2026" : "Working\u2026";
    const params = { prompt: buildAutoPrompt(prompt, snap), folder: snap.folder };
    if (autoSessionId) params.resume = autoSessionId;
    send("agent-run", params, { onProgress: (p2) => {
      feed.value = [...feed.value, { id: ++feedId, label: p2.label || "Working", ...p2.detail ? { detail: p2.detail } : {} }];
    }, onResult: (data) => {
      if (data.sessionId) autoSessionId = data.sessionId;
      if (data.landedCut) {
        designRunning.value = false;
        designNote.value = "The AI proposed your cut \u2014 opening Export\u2026";
        refresh(() => goto("export"));
        return;
      }
      send("design-cut", { folder: snap.folder, kind: cutKindFromPrompt(prompt) }, { onResult: () => {
        designRunning.value = false;
        refresh(() => goto("export"));
      }, onError: (error) => {
        designRunning.value = false;
        designNote.value = error.message;
      } });
    }, onError: (error) => {
      designRunning.value = false;
      designNote.value = error.code === "not_connected" ? "Claude isn't connected." : error.message;
    } });
  }
  function startReview() {
    const snap = project.value;
    if (!snap) {
      manualNote.value = "Open a project first (New Project).";
      return;
    }
    const artifacts = snap.project.artifacts;
    if (artifacts.includes("cut") && !artifacts.includes("switches")) {
      manualNote.value = "Timeline editing currently supports multi-camera projects. Your cut is ready to Export.";
      return;
    }
    const launch = () => {
      reviewStatus.value = "Starting the review UI\u2026";
      send("review-start", { folder: project.value?.folder || snap.folder }, { onResult: (data) => {
        reviewUrl.value = data.url;
        reviewStatus.value = "";
      }, onError: (error) => {
        reviewStatus.value = error.message;
      } });
    };
    if (artifacts.includes("switches")) launch();
    else {
      manualNote.value = "Proposing an auto starting cut\u2026";
      send("design-cut", { folder: snap.folder }, { onResult: () => refresh(launch), onError: (error) => {
        manualNote.value = error.message;
      } });
    }
  }
  function loadExportPreview() {
    const snap = project.value;
    if (!snap || previewFolder === snap.folder) return;
    previewFolder = snap.folder;
    previewUrl.value = "";
    audioMap.value = [];
    previewStatus.value = "Rendering a lightweight preview\u2026";
    send("export-preview", { folder: snap.folder }, {
      onProgress: (progress) => {
        if (progress.message) previewStatus.value = progress.message.slice(0, 90);
      },
      onResult: (data) => {
        const convert = getTauri().core.convertFileSrc;
        previewUrl.value = convert ? convert(data.outPath) : data.outPath;
        audioMap.value = data.audioMap || [];
        previewStatus.value = "";
      },
      onError: (error) => {
        previewFolder = "";
        previewStatus.value = `Preview unavailable: ${error.message}`;
      }
    });
  }
  function runExport(kind) {
    const snap = project.value;
    if (!snap || !kind) {
      if (kind) updateExport(kind, { status: "open a project first" });
      return;
    }
    updateExport(kind, { status: "rendering\u2026", running: true, outPath: void 0 });
    const id = send(`export-${kind}`, { folder: snap.folder }, { onProgress: (p2) => updateExport(kind, { status: p2.message ? `rendering\u2026 ${p2.message}`.slice(0, 60) : "rendering\u2026" }), onResult: (data) => {
      requestByKind.delete(kind);
      updateExport(kind, { status: "done", running: false, outPath: data.outPath });
    }, onError: (error) => {
      requestByKind.delete(kind);
      updateExport(kind, { status: `error: ${error.message}`, running: false });
    } });
    requestByKind.set(kind, id);
  }
  function submitInteraction(root, decision) {
    const active = activeInteraction.value;
    if (!active) return;
    root.querySelector("#interaction-dialog")?.close();
    let value;
    if (active.interaction.kind === "question" && decision === "completed") {
      const questions = active.interaction.payload?.questions || [];
      const answers = {};
      questions.forEach((question, index) => {
        answers[question.question] = [...root.querySelectorAll(`[name="question-${index}"]:checked`)].map((input) => input.value).join(", ");
      });
      value = { questions, answers };
    }
    answerInteraction(active.interactionId, decision, value);
    activeInteraction.value = null;
    showNextInteraction();
  }
  var ACTIONS, defaultStages, PRESETS, PERMISSIONS, stages, screen, project, recents, doctorRows, doctorStatus, importStatus, importRequest, analyzeStatus, analyzeRequest, designPrompt, designNote, manualNote, feed, designRunning, reviewUrl, reviewStatus, config, exportsState, previewUrl, previewStatus, audioMap, previewFolder, activeInteraction, autoSessionId, feedId, EXPORTS, getTauri, pending, interactionQueue, requestByKind, nextId;
  var init_desktop_app = __esm({
    "ui/desktop-app.tsx"() {
      "use strict";
      init_kerf();
      init_jsx_runtime();
      ACTIONS = {
        stage: attr("data-action", "stage"),
        permissions: attr("data-action", "permissions"),
        doctor: attr("data-action", "doctor"),
        openProject: attr("data-action", "open-project"),
        createProject: attr("data-action", "create-project"),
        recent: attr("data-action", "recent"),
        importRun: attr("data-action", "import-run"),
        importCancel: attr("data-action", "import-cancel"),
        analyzeRun: attr("data-action", "analyze-run"),
        analyzeCancel: attr("data-action", "analyze-cancel"),
        preset: attr("data-action", "preset"),
        designMake: attr("data-action", "design-make"),
        timeline: attr("data-action", "timeline"),
        exportRun: attr("data-action", "export-run"),
        exportCancel: attr("data-action", "export-cancel"),
        reveal: attr("data-action", "reveal"),
        policy: attr("data-action", "policy"),
        revoke: attr("data-action", "revoke"),
        resetRules: attr("data-action", "reset-rules"),
        interaction: attr("data-action", "interaction"),
        designPrompt: attr("data-role", "design-prompt"),
        previewCue: attr("data-action", "preview-cue"),
        retryPreview: attr("data-action", "retry-preview")
      };
      defaultStages = [
        { key: "setup", label: "Setup", state: "active" },
        { key: "new-project", label: "New Project", state: "idle" },
        { key: "analyze", label: "Analyze", state: "locked" },
        { key: "design", label: "Design", state: "locked" },
        { key: "export", label: "Export", state: "locked" }
      ];
      PRESETS = [
        ["Teaser", "a punchy 15-second teaser that hooks the viewer"],
        ["Trailer", "a 60\u201390 second trailer that sets up what this is and builds to a hook"],
        ["Highlights", "a highlights reel of the best moments"],
        ["Summary", "a tight summary that covers the key points in about a minute"],
        ["Sizzle", "an energetic sizzle reel \u2014 a fast-paced montage of the most dynamic moments"],
        ["Soundbites", "the strongest spoken soundbites, tightly cut"],
        ["9:16 reel", "a 9:16 vertical reel for social (Reels / TikTok / Shorts)"],
        ["Full song (music)", "a full music-video edit cut to the track"]
      ];
      PERMISSIONS = [
        ["media-processing", "Process video", "ffmpeg / whisper / our pipeline tools", "allow", true],
        ["read-in-project", "Read this project", "read files inside the project folder", "allow", true],
        ["write-in-project", "Write results here", "write outputs into the project folder", "allow", true],
        ["network-egress", "Access the network", "anything beyond local Ollama + the agent API", "ask", true],
        ["other-shell", "Run other commands", "shell that isn't recognized", "ask", true],
        ["destructive", "Delete / write outside the project", "always asks, for your safety", "ask", false]
      ];
      stages = signal(defaultStages);
      screen = signal("setup");
      project = signal(null);
      recents = signal([]);
      doctorRows = signal([]);
      doctorStatus = signal("");
      importStatus = signal("");
      importRequest = signal(null);
      analyzeStatus = signal("");
      analyzeRequest = signal(null);
      designPrompt = signal("");
      designNote = signal("");
      manualNote = signal("");
      feed = signal([]);
      designRunning = signal(false);
      reviewUrl = signal("");
      reviewStatus = signal("");
      config = signal({});
      exportsState = signal({ mp4: { status: "ready", running: false }, social: { status: "ready", running: false }, fcpxml: { status: "ready", running: false } });
      previewUrl = signal("");
      previewStatus = signal("");
      audioMap = signal([]);
      previewFolder = "";
      activeInteraction = signal(null);
      autoSessionId = null;
      feedId = 0;
      EXPORTS = [{ kind: "mp4", title: "MP4", desc: "Finished 16:9 video (1280\xD7720)" }, { kind: "social", title: "9:16 Social", desc: "Vertical reel (1080\xD71920)" }, { kind: "fcpxml", title: "Final Cut Pro", desc: "FCPXML handoff (re-cuttable)" }];
      getTauri = () => {
        const api = window.__TAURI__;
        if (!api) throw new Error("Tauri API unavailable");
        return api;
      };
      pending = /* @__PURE__ */ new Map();
      interactionQueue = [];
      requestByKind = /* @__PURE__ */ new Map();
      nextId = 1;
    }
  });

  // ui/desktop-entry.tsx
  var require_desktop_entry = __commonJS({
    "ui/desktop-entry.tsx"() {
      init_desktop_app();
      var root = document.getElementById("app");
      if (root) bootDesktop(root);
    }
  });
  require_desktop_entry();
})();
