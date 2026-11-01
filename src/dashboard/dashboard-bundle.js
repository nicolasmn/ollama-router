var L=globalThis,U=L.ShadowRoot&&(L.ShadyCSS===void 0||L.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,me=Symbol(),pe=new WeakMap,I=class{constructor(e,t,a){if(this._$cssResult$=!0,a!==me)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(U&&e===void 0){let a=t!==void 0&&t.length===1;a&&(e=pe.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),a&&pe.set(t,e))}return e}toString(){return this.cssText}},ge=s=>new I(typeof s=="string"?s:s+"",void 0,me);var ve=(s,e)=>{if(U)s.adoptedStyleSheets=e.map(t=>t instanceof CSSStyleSheet?t:t.styleSheet);else for(let t of e){let a=document.createElement("style"),n=L.litNonce;n!==void 0&&a.setAttribute("nonce",n),a.textContent=t.cssText,s.appendChild(a)}},K=U?s=>s:s=>s instanceof CSSStyleSheet?(e=>{let t="";for(let a of e.cssRules)t+=a.cssText;return ge(t)})(s):s;var{is:Ye,defineProperty:Ze,getOwnPropertyDescriptor:et,getOwnPropertyNames:tt,getOwnPropertySymbols:st,getPrototypeOf:at}=Object,H=globalThis,fe=H.trustedTypes,nt=fe?fe.emptyScript:"",it=H.reactiveElementPolyfillSupport,T=(s,e)=>s,Q={toAttribute(s,e){switch(e){case Boolean:s=s?nt:null;break;case Object:case Array:s=s==null?s:JSON.stringify(s)}return s},fromAttribute(s,e){let t=s;switch(e){case Boolean:t=s!==null;break;case Number:t=s===null?null:Number(s);break;case Object:case Array:try{t=JSON.parse(s)}catch{t=null}}return t}},be=(s,e)=>!Ye(s,e),$e={attribute:!0,type:String,converter:Q,reflect:!1,useDefault:!1,hasChanged:be};Symbol.metadata??=Symbol("metadata"),H.litPropertyMetadata??=new WeakMap;var w=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=$e){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let a=Symbol(),n=this.getPropertyDescriptor(e,a,t);n!==void 0&&Ze(this.prototype,e,n)}}static getPropertyDescriptor(e,t,a){let{get:n,set:i}=et(this.prototype,e)??{get(){return this[t]},set(o){this[t]=o}};return{get:n,set(o){let c=n?.call(this);i?.call(this,o),this.requestUpdate(e,c,a)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??$e}static _$Ei(){if(this.hasOwnProperty(T("elementProperties")))return;let e=at(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(T("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(T("properties"))){let t=this.properties,a=[...tt(t),...st(t)];for(let n of a)this.createProperty(n,t[n])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[a,n]of t)this.elementProperties.set(a,n)}this._$Eh=new Map;for(let[t,a]of this.elementProperties){let n=this._$Eu(t,a);n!==void 0&&this._$Eh.set(n,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let a=new Set(e.flat(1/0).reverse());for(let n of a)t.unshift(K(n))}else e!==void 0&&t.push(K(e));return t}static _$Eu(e,t){let a=t.attribute;return a===!1?void 0:typeof a=="string"?a:typeof e=="string"?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let a of t.keys())this.hasOwnProperty(a)&&(e.set(a,this[a]),delete this[a]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ve(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,a){this._$AK(e,a)}_$ET(e,t){let a=this.constructor.elementProperties.get(e),n=this.constructor._$Eu(e,a);if(n!==void 0&&a.reflect===!0){let i=(a.converter?.toAttribute!==void 0?a.converter:Q).toAttribute(t,a.type);this._$Em=e,i==null?this.removeAttribute(n):this.setAttribute(n,i),this._$Em=null}}_$AK(e,t){let a=this.constructor,n=a._$Eh.get(e);if(n!==void 0&&this._$Em!==n){let i=a.getPropertyOptions(n),o=typeof i.converter=="function"?{fromAttribute:i.converter}:i.converter?.fromAttribute!==void 0?i.converter:Q;this._$Em=n;let c=o.fromAttribute(t,i.type);this[n]=c??this._$Ej?.get(n)??c,this._$Em=null}}requestUpdate(e,t,a,n=!1,i){if(e!==void 0){let o=this.constructor;if(n===!1&&(i=this[e]),a??=o.getPropertyOptions(e),!((a.hasChanged??be)(i,t)||a.useDefault&&a.reflect&&i===this._$Ej?.get(e)&&!this.hasAttribute(o._$Eu(e,a))))return;this.C(e,t,a)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(e,t,{useDefault:a,reflect:n,wrapped:i},o){a&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,o??t??this[e]),i!==!0||o!==void 0)||(this._$AL.has(e)||(this.hasUpdated||a||(t=void 0),this._$AL.set(e,t)),n===!0&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[n,i]of this._$Ep)this[n]=i;this._$Ep=void 0}let a=this.constructor.elementProperties;if(a.size>0)for(let[n,i]of a){let{wrapped:o}=i,c=this[n];o!==!0||this._$AL.has(n)||c===void 0||this.C(n,void 0,i,c)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(a=>a.hostUpdate?.()),this.update(t)):this._$EM()}catch(a){throw e=!1,this._$EM(),a}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(t=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(t=>this._$ET(t,this[t])),this._$EM()}updated(e){}firstUpdated(e){}};w.elementStyles=[],w.shadowRootOptions={mode:"open"},w[T("elementProperties")]=new Map,w[T("finalized")]=new Map,it?.({ReactiveElement:w}),(H.reactiveElementVersions??=[]).push("2.1.2");var se=globalThis,ye=s=>s,D=se.trustedTypes,we=D?D.createPolicy("lit-html",{createHTML:s=>s}):void 0,Ce="$lit$",_=`lit$${Math.random().toFixed(9).slice(2)}$`,ke="?"+_,rt=`<${ke}>`,A=document,q=()=>A.createComment(""),O=s=>s===null||typeof s!="object"&&typeof s!="function",ae=Array.isArray,ot=s=>ae(s)||typeof s?.[Symbol.iterator]=="function",G=`[ 	
\f\r]`,R=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,_e=/-->/g,xe=/>/g,E=RegExp(`>|${G}(?:([^\\s"'>=/]+)(${G}*=${G}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),Ee=/'/g,Se=/"/g,Me=/^(?:script|style|textarea|title)$/i,ne=s=>(e,...t)=>({_$litType$:s,strings:e,values:t}),r=ne(1),ie=ne(2),Pt=ne(3),C=Symbol.for("lit-noChange"),v=Symbol.for("lit-nothing"),Ae=new WeakMap,S=A.createTreeWalker(A,129);function Te(s,e){if(!ae(s)||!s.hasOwnProperty("raw"))throw Error("invalid template strings array");return we!==void 0?we.createHTML(e):e}var lt=(s,e)=>{let t=s.length-1,a=[],n,i=e===2?"<svg>":e===3?"<math>":"",o=R;for(let c=0;c<t;c++){let l=s[c],d,u,h=-1,m=0;for(;m<l.length&&(o.lastIndex=m,u=o.exec(l),u!==null);)m=o.lastIndex,o===R?u[1]==="!--"?o=_e:u[1]!==void 0?o=xe:u[2]!==void 0?(Me.test(u[2])&&(n=RegExp("</"+u[2],"g")),o=E):u[3]!==void 0&&(o=E):o===E?u[0]===">"?(o=n??R,h=-1):u[1]===void 0?h=-2:(h=o.lastIndex-u[2].length,d=u[1],o=u[3]===void 0?E:u[3]==='"'?Se:Ee):o===Se||o===Ee?o=E:o===_e||o===xe?o=R:(o=E,n=void 0);let g=o===E&&s[c+1].startsWith("/>")?" ":"";i+=o===R?l+rt:h>=0?(a.push(d),l.slice(0,h)+Ce+l.slice(h)+_+g):l+_+(h===-2?c:g)}return[Te(s,i+(s[t]||"<?>")+(e===2?"</svg>":e===3?"</math>":"")),a]},N=class s{constructor({strings:e,_$litType$:t},a){let n;this.parts=[];let i=0,o=0,c=e.length-1,l=this.parts,[d,u]=lt(e,t);if(this.el=s.createElement(d,a),S.currentNode=this.el.content,t===2||t===3){let h=this.el.content.firstChild;h.replaceWith(...h.childNodes)}for(;(n=S.nextNode())!==null&&l.length<c;){if(n.nodeType===1){if(n.hasAttributes())for(let h of n.getAttributeNames())if(h.endsWith(Ce)){let m=u[o++],g=n.getAttribute(h).split(_),y=/([.?@])?(.*)/.exec(m);l.push({type:1,index:i,name:y[2],strings:g,ctor:y[1]==="."?Y:y[1]==="?"?Z:y[1]==="@"?ee:M}),n.removeAttribute(h)}else h.startsWith(_)&&(l.push({type:6,index:i}),n.removeAttribute(h));if(Me.test(n.tagName)){let h=n.textContent.split(_),m=h.length-1;if(m>0){n.textContent=D?D.emptyScript:"";for(let g=0;g<m;g++)n.append(h[g],q()),S.nextNode(),l.push({type:2,index:++i});n.append(h[m],q())}}}else if(n.nodeType===8)if(n.data===ke)l.push({type:2,index:i});else{let h=-1;for(;(h=n.data.indexOf(_,h+1))!==-1;)l.push({type:7,index:i}),h+=_.length-1}i++}}static createElement(e,t){let a=A.createElement("template");return a.innerHTML=e,a}};function k(s,e,t=s,a){if(e===C)return e;let n=a!==void 0?t._$Co?.[a]:t._$Cl,i=O(e)?void 0:e._$litDirective$;return n?.constructor!==i&&(n?._$AO?.(!1),i===void 0?n=void 0:(n=new i(s),n._$AT(s,t,a)),a!==void 0?(t._$Co??=[])[a]=n:t._$Cl=n),n!==void 0&&(e=k(s,n._$AS(s,e.values),n,a)),e}var X=class{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:a}=this._$AD,n=(e?.creationScope??A).importNode(t,!0);S.currentNode=n;let i=S.nextNode(),o=0,c=0,l=a[0];for(;l!==void 0;){if(o===l.index){let d;l.type===2?d=new P(i,i.nextSibling,this,e):l.type===1?d=new l.ctor(i,l.name,l.strings,this,e):l.type===6&&(d=new te(i,this,e)),this._$AV.push(d),l=a[++c]}o!==l?.index&&(i=S.nextNode(),o++)}return S.currentNode=A,n}p(e){let t=0;for(let a of this._$AV)a!==void 0&&(a.strings!==void 0?(a._$AI(e,a,t),t+=a.strings.length-2):a._$AI(e[t])),t++}},P=class s{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,a,n){this.type=2,this._$AH=v,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=a,this.options=n,this._$Cv=n?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=k(this,e,t),O(e)?e===v||e==null||e===""?(this._$AH!==v&&this._$AR(),this._$AH=v):e!==this._$AH&&e!==C&&this._(e):e._$litType$!==void 0?this.$(e):e.nodeType!==void 0?this.T(e):ot(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==v&&O(this._$AH)?this._$AA.nextSibling.data=e:this.T(A.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:a}=e,n=typeof a=="number"?this._$AC(e):(a.el===void 0&&(a.el=N.createElement(Te(a.h,a.h[0]),this.options)),a);if(this._$AH?._$AD===n)this._$AH.p(t);else{let i=new X(n,this),o=i.u(this.options);i.p(t),this.T(o),this._$AH=i}}_$AC(e){let t=Ae.get(e.strings);return t===void 0&&Ae.set(e.strings,t=new N(e)),t}k(e){ae(this._$AH)||(this._$AH=[],this._$AR());let t=this._$AH,a,n=0;for(let i of e)n===t.length?t.push(a=new s(this.O(q()),this.O(q()),this,this.options)):a=t[n],a._$AI(i),n++;n<t.length&&(this._$AR(a&&a._$AB.nextSibling,n),t.length=n)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let a=ye(e).nextSibling;ye(e).remove(),e=a}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}},M=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,a,n,i){this.type=1,this._$AH=v,this._$AN=void 0,this.element=e,this.name=t,this._$AM=n,this.options=i,a.length>2||a[0]!==""||a[1]!==""?(this._$AH=Array(a.length-1).fill(new String),this.strings=a):this._$AH=v}_$AI(e,t=this,a,n){let i=this.strings,o=!1;if(i===void 0)e=k(this,e,t,0),o=!O(e)||e!==this._$AH&&e!==C,o&&(this._$AH=e);else{let c=e,l,d;for(e=i[0],l=0;l<i.length-1;l++)d=k(this,c[a+l],t,l),d===C&&(d=this._$AH[l]),o||=!O(d)||d!==this._$AH[l],d===v?e=v:e!==v&&(e+=(d??"")+i[l+1]),this._$AH[l]=d}o&&!n&&this.j(e)}j(e){e===v?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}},Y=class extends M{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===v?void 0:e}},Z=class extends M{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==v)}},ee=class extends M{constructor(e,t,a,n,i){super(e,t,a,n,i),this.type=5}_$AI(e,t=this){if((e=k(this,e,t,0)??v)===C)return;let a=this._$AH,n=e===v&&a!==v||e.capture!==a.capture||e.once!==a.once||e.passive!==a.passive,i=e!==v&&(a===v||n);n&&this.element.removeEventListener(this.name,this,a),i&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}},te=class{constructor(e,t,a){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=a}get _$AU(){return this._$AM._$AU}_$AI(e){k(this,e)}};var dt=se.litHtmlPolyfillSupport;dt?.(N,P),(se.litHtmlVersions??=[]).push("3.3.2");var Re=(s,e,t)=>{let a=t?.renderBefore??e,n=a._$litPart$;if(n===void 0){let i=t?.renderBefore??null;a._$litPart$=n=new P(e.insertBefore(q(),i),i,void 0,t??{})}return n._$AI(s),n};var re=globalThis,f=class extends w{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=Re(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return C}};f._$litElement$=!0,f.finalized=!0,re.litElementHydrateSupport?.({LitElement:f});var ct=re.litElementPolyfillSupport;ct?.({LitElement:f});(re.litElementVersions??=[]).push("4.2.2");var B=5,p={bytes:s=>s>0?`${(s/1e9).toFixed(1)} GB`:"\u2014",ctx:s=>s?s>=1e3?`${(s/1e3).toFixed(0)}k`:String(s):"\u2014",duration:s=>s==null||s<0?"\u2014":s<1e3?`${s.toFixed(0)}ms`:s<1e4?`${(s/1e3).toFixed(1)}s`:s<6e4?`${Math.floor(s/1e3)}s`:`${Math.floor(s/6e4)}m ${(s%6e4/1e3).toFixed(0)}s`,countdown:s=>{if(!s||s<=0)return"\u2014";let e=s-Date.now();if(e<=0)return"now";let t=Math.ceil(e/6e4),a=Math.floor(t/60),n=Math.floor(a/24),i=a%24,o=t%60;return n>0?i>0?`${n}d ${i}h`:`${n}d`:a>0?o>0?`${a}h ${o}m`:`${a}h`:t<1?"< 1m":`${t}m`},tps:s=>s>0?s.toFixed(1):"\u2014",params:s=>s>0?`${s.toFixed(1)}B`:"\u2014",ago:s=>{if(!s)return"\u2014";let e=Date.now()-s;return e<5e3?"just now":e<6e4?`${Math.floor(e/1e3)}s ago`:e<36e5?`${Math.floor(e/6e4)}m ago`:`${Math.floor(e/36e5)}h ago`},status:s=>s==="success"?"Success":s==="waiting"?"Waiting":s==="running"?"Running":s==="aborted"?"Aborted":s==="capacity"?"Capacity":s==="rejected"?"Rejected":"Failed"};function Pe(s){return s==="client_disconnect"?"Client disconnected":s==="upstream_abort"?"Upstream aborted":s||"Unknown"}function Le(s){return s==="capacity"?"Capacity":s==="network"?"Network":s==="timeout"?"Timeout":s==="upstream_error"?"Upstream error":s==="client_abort"?"Client abort":s||"Unknown"}function Ie(s){return s==="retry_now"?"Retry now":s==="retry_later"?"Retry in a few seconds":s==="switch_model"?"Try another model":s==="no_retry"?"No retry needed":s||"No hint"}function F(s){return!s||s<=0?"muted":s<500?"good":s<2e3?"warn":"bad"}function z(s){return s==="embeddings"?"Embeddings":s==="completions"?"Completions":s==="systemone"?"SystemOne":s==="audio"?"Audio":"Chat"}function Ue(s){return s==="waiting"?"waiting":s==="running"?"running":s==="success"?"success":s==="rejected"?"rejected":s==="capacity"?"capacity":s==="aborted"?"aborted":"failed"}function He(s){if(s.selectedNode&&s.selectedNode.includes("ollama.com")||s.selectedModel&&s.selectedModel.includes("ollama.com")||s.selectedModel&&s.selectedModel.includes("(cloud)"))return!0;let e=s.attempts?.find(t=>t.status==="success"||t.status==="running"||t.status==="waiting");return e?e.nodeHost?.includes("ollama.com")??!1:!1}function W(s){return s.selectedModel||s.candidates?.[0]?.modelName||"\u2014"}function De(s){return s.status!=="failed"&&s.status!=="rejected"?null:s.error?s.error:s.attempts?.[s.attempts.length-1]?.error||null}function oe(s){return s.promptChars>0?`[redacted] \xB7 ${s.promptChars} chars`:"No preview"}function je(s){let e=[];return s.inputSummary&&e.push(s.inputSummary),s.candidateCount>0&&e.push(`${s.candidateCount} candidate${s.candidateCount===1?"":"s"}`),s.attemptCount>1?e.push(`${s.attemptCount} attempts`):s.attemptCount===1&&s.status!=="running"&&s.status!=="waiting"&&e.push("1 attempt"),s.stream&&e.push("stream"),e}function Be(s={}){let e=[];return s.supportsVision&&e.push(r`<span class="cap vision">Vision</span>`),s.supportsTools&&e.push(r`<span class="cap tools">Tools</span>`),s.supportsThinking&&e.push(r`<span class="cap thinking">Thinking</span>`),s.supportsAudio&&e.push(r`<span class="cap audio">Audio</span>`),s.supportsDecision&&e.push(r`<span class="cap decision" title="SystemOne decision model">Decision</span>`),s.isEmbedding&&e.push(r`<span class="cap embedding">Embed</span>`),e.length?r`<div class="caps">${e}</div>`:r`<span class="muted cap-fallback">text</span>`}function Fe(s=[]){let e=s.flatMap(l=>Object.values(l.models||{})),t=s.filter(l=>l.reachable).length,a=s.reduce((l,d)=>l+(d.activeRequests||0),0),n=e.map(l=>l.recentTtft>0?l.recentTtft:l.recentLatency).filter(l=>l>0),i=e.map(l=>l.recentTps).filter(l=>l>0),o=n.length?n.reduce((l,d)=>l+d,0)/n.length:0,c=i.length?i.reduce((l,d)=>l+d,0)/i.length:0;return{online:t,totalNodes:s.length,totalModels:e.length,totalReqs:a,avgLat:o,avgTps:c}}function ze(s={}){let e=[];return s.preferReasoning&&e.push(r`<span class="badge b-yellow">reasoning</span>`),s.preferFast&&e.push(r`<span class="badge b-blue">fast</span>`),s.hasCodeSignals&&e.push(r`<span class="badge">code</span>`),s.needsTools&&e.push(r`<span class="badge b-blue">tools</span>`),s.needsVision&&e.push(r`<span class="badge">vision</span>`),s.needsAudio&&e.push(r`<span class="badge">audio</span>`),s.needsEmbeddings&&e.push(r`<span class="badge b-green">embedding</span>`),e.length?e:r`<span class="muted">—</span>`}var x=s=>s>0?`+${s.toFixed(1)}`:s<0?`\u2212${Math.abs(s).toFixed(1)}`:"0.0",j=s=>s>.05?"rd-pos":s<-.05?"rd-neg":"rd-zero",ut={measured:"measured",blended:"measured + estimate",estimated:"estimate",live:"live",static:"model info"};function V(s){return Array.isArray(s?.rationale?.factors)}var ht=new Set(["quality","latency","throughput","context","warm"]);function We(s,e){return ht.has(s.id)?s.weight>0:e.some(t=>t!==0)}function J(s,e){return s?.rationale?.factors?.find(t=>t.id===e)}function pt(s){let e=s.find(V);return e?e.rationale.factors.filter(t=>We(t,s.map(a=>J(a,t.id)?.points??0))):[]}function mt(s){return s.length>18?`${s.slice(0,17)}\u2026`:s}function gt(s){return String(s||"").replace(/^https?:\/\//,"").replace(/:11434$/,"")}function vt(s){let e=s[0],t=e?.rationale;if(!t?.ranking)return"";let{ranking:a}=t;if(!a.against)return r`<span class="rd-verdict-main">Only one eligible candidate.</span>`;let n=J(e,a.decisive);return r`
    <span class="rd-verdict-main">
      <strong>${e.modelName}</strong> leads
      <span class="rd-pos">${x(a.gap)}</span> over ${a.against}
    </span>
    ${n?r`<span class="rd-verdict-why">
          mainly <strong>${n.label}</strong>
          <span class="${j(a.decisiveDelta)}">${x(a.decisiveDelta)}</span>
          — ${n.detail}
        </span>`:""}
  `}function ft(s,e){let t=e.filter(n=>n.weight>0&&["quality","latency","throughput","context","warm","thinking"].includes(n.id)),a=t.reduce((n,i)=>n+i.weight,0)||1;return r`
    <div class="rd-weights" title="How much each factor can contribute under this profile">
      ${t.map(n=>r`
        <span class="rd-weight-seg rd-f-${n.id}" style="flex:${n.weight/a}"></span>`)}
    </div>
    <div class="rd-weight-legend">
      ${t.map(n=>r`
        <span class="rd-legend-item"><i class="rd-dot rd-f-${n.id}"></i>${n.label} ${n.weight}</span>`)}
    </div>
  `}function Ve(s){let e=(s||[]).filter(V);if(!e.length)return"";let{profile:t,factors:a}=e[0].rationale;return r`
    <div class="rd-summary">
      <div class="rd-profile">
        <span class="badge b-blue">${t.kind}</span>
        <span class="rd-profile-reason">${t.reason}</span>
        ${t.tags.map(n=>r`<span class="badge">${n}</span>`)}
      </div>
      <div class="rd-verdict">${vt(e)}</div>
      ${ft(t,a)}
    </div>
  `}function Je(s,e){let t=(s||[]).filter(V);if(t.length<2)return"";let a=pt(t),n=i=>`${i.modelName}@${i.nodeHost}`;return r`
    <div class="rd-matrix-wrap">
      <table class="rd-matrix">
        <thead>
          <tr>
            <th></th>
            ${t.map(i=>r`
              <th class="${n(i)===e?"rd-col-winner":""}" title="${i.modelName} @ ${i.nodeHost}">
                <div class="rd-col-model">${mt(i.modelName)}</div>
                <div class="rd-col-host">${gt(i.nodeHost)}</div>
              </th>`)}
          </tr>
        </thead>
        <tbody>
          ${a.map(i=>r`
            <tr>
              <th class="rd-row-label" title="${i.detail}">${i.label}</th>
              ${t.map(o=>{let c=J(o,i.id);return r`<td class="${j(c?.points??0)} ${n(o)===e?"rd-col-winner":""}"
                  title="${c?.detail??""}">${c?x(c.points):"\u2014"}</td>`})}
            </tr>`)}
          <tr class="rd-total-row">
            <th class="rd-row-label">Total</th>
            ${t.map(i=>r`
              <td class="${n(i)===e?"rd-col-winner":""}">${i.rationale.total.toFixed(1)}</td>`)}
          </tr>
        </tbody>
      </table>
    </div>
  `}function Ke(s,e){if(!V(s))return"";let t=s.rationale,a=e&&e.modelName===s.modelName&&e.nodeHost===s.nodeHost,n=t.factors.filter(o=>We(o,[o.points])),i=t.ranking;return r`
    <div class="rd-detail">
      ${i&&i.against?r`<div class="rd-rank">
            ${a?r`Rank 1 of ${i.of} · <span class="rd-pos">${x(i.gap)}</span> vs ${i.against}`:r`Rank ${i.rank} of ${i.of} · <span class="rd-neg">${x(i.gap)}</span> vs ${i.against}${i.decisive?r`, mostly ${t.factors.find(o=>o.id===i.decisive)?.label??i.decisive} <span class="rd-neg">${x(i.decisiveDelta)}</span>`:""}`}
          </div>`:""}
      ${n.map(o=>{let c=J(e,o.id),l=!a&&c?o.points-c.points:null,d=Math.min(100,Math.abs(o.value)*100);return r`
          <div class="rd-factor">
            <div class="rd-factor-head">
              <span class="rd-factor-label">${o.label}</span>
              <span class="rd-meter ${o.value<0?"rd-meter-neg":""}">
                <span class="rd-meter-fill rd-f-${o.id}" style="width:${d}%"></span>
              </span>
              <span class="rd-factor-pts ${j(o.points)}">${x(o.points)}</span>
              <span class="rd-factor-delta ${l===null?"":j(l)}"
                title="Difference to the winner's contribution">${l===null||Math.abs(l)<.05?"":x(l)}</span>
            </div>
            <div class="rd-factor-detail">
              <span class="rd-src rd-src-${o.source}">${ut[o.source]??o.source}</span>
              ${o.detail}
              <span class="rd-factor-calc">· ${(o.value*100).toFixed(0)}% × ${o.weight}</span>
            </div>
          </div>`})}
      <div class="rd-factor rd-factor-total">
        <div class="rd-factor-head">
          <span class="rd-factor-label">Total</span>
          <span class="rd-meter"></span>
          <span class="rd-factor-pts">${t.total.toFixed(1)}</span>
          <span class="rd-factor-delta"></span>
        </div>
      </div>
    </div>
  `}function Qe(s="Typing"){return r`
    <span class="typing-indicator" aria-label="${s}">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
  `}function $t(s,e={}){if(!s)return e.showTyping?Qe(e.typingLabel||"Typing"):r`<span class="muted">(empty)</span>`;let t=[],a=/```(\w*)\n?([\s\S]*?)```/g,n=0,i;for(;(i=a.exec(s))!==null;){let c=s.slice(n,i.index);c&&t.push(qe(c));let l=i[1]||"",d=i[2];if((l==="json"||l==="")&&d.trim().startsWith("{"))try{d=JSON.stringify(JSON.parse(d),null,2),l="json"}catch{}t.push(r`<pre class="msg-code-block"><code class="msg-code-lang">${l?r`<span class="msg-code-label">${l}</span>`:""}</code><code class=${l?`language-${l}`:""}>${d}</code></pre>`),n=i.index+i[0].length}let o=s.slice(n);return o&&t.push(qe(o)),t}function qe(s){let e=[],t=/`([^`]+)`/g,a=0,n;for(;(n=t.exec(s))!==null;){let o=s.slice(a,n.index);o&&e.push(r`<span class="msg-text">${o}</span>`),e.push(r`<code class="msg-code-inline">${n[1]}</code>`),a=n.index+n[0].length}let i=s.slice(a);return i&&e.push(r`<span class="msg-text">${i}</span>`),e}function bt(s,e=!1){return!s&&!e?"":r`
    <details class="msg-thinking ${e?"is-live":""}" ?open=${e}>
      <summary class="msg-thinking-summary">
        <span class="msg-thinking-icon">◆</span>
        Thinking
      </summary>
      <div class="msg-thinking-content">
        ${s||Qe("Thinking in progress")}
      </div>
    </details>
  `}function yt(s){return!s||!s.length?"":r`
    <div class="msg-images">
      ${s.map(e=>r`
          <a
            class="msg-image-link"
            href="${e.url}"
            target="_blank"
            rel="noopener noreferrer"
            title="Open image"
          >
            <img
              class="msg-image-thumb"
              src="${e.url}"
              alt="Attached image"
              loading="lazy"
              decoding="async"
            />
          </a>
        `)}
    </div>
  `}function wt(s){return s?.length?s.map(e=>{let t=e.function.arguments;try{t=JSON.stringify(JSON.parse(e.function.arguments),null,2)}catch{}return r`
      <div class="msg-tool-call">
        <div class="msg-tool-call-header">
          <span class="msg-tool-call-icon">ƒ</span>
          <span class="msg-tool-call-name">${e.function.name}</span>
          ${e.id?r`<span class="msg-tool-call-id">${e.id}</span>`:""}
        </div>
        <pre class="msg-tool-call-args">${t}</pre>
      </div>
    `}):""}function _t(s,e){let t=s.name||"";if(!t&&s.toolCallId&&e){for(let a of e)if(a.toolCalls){let n=a.toolCalls.find(i=>i.id===s.toolCallId);if(n){t=n.function.name;break}}}return r`
    <div class="msg-tool-result">
      <div class="msg-tool-result-header">
        <span class="msg-tool-result-icon">↩</span>
        ${t?r`<span class="msg-tool-result-name">${t}</span>`:r`<span class="msg-tool-result-name muted">tool result</span>`}
        ${s.toolCallId?r`<span class="msg-tool-call-id">${s.toolCallId}</span>`:""}
      </div>
      <pre class="msg-tool-result-content">${s.content||r`<span class="muted">(empty)</span>`}</pre>
    </div>
  `}function Oe(s,e,t=!1){if(s.role==="tool")return _t(s,e);let a=bt(s.thinking,t),n=wt(s.toolCalls),i=yt(s.images),o=$t(s.content,{showTyping:t,typingLabel:"Assistant is typing"});return s.role==="system"&&s.content?.length>200?r`
      ${a}
      ${n}
      ${i}
      <details class="msg-system-details">
        <summary class="msg-system-summary">
          ${s.content.slice(0,120).trim()}…
        </summary>
        <div class="msg-body-inner">${o}</div>
      </details>
    `:r`${a}${n}${i}<div class="msg-body-inner">${o}</div>`}var Ne={system:"System",user:"User",assistant:"Assistant",tool:"Tool",state:"State",question:"Question"};function b(s){return`${Math.round(s*100)}%`}function xt(s,e){let t=Math.min(1,Math.max(0,Number(e.noul)||0));return r`
    <div class="so-answer">
      <div class="so-answer-title">${s}</div>
      <div class="so-noul">
        <span class="so-noul-label so-noul-label--false">false ${b(1-t)}</span>
        <div class="so-noul-bar" title="${b(t)} true">
          <div class="so-noul-fill so-noul-fill--false" style="width: ${b(1-t)}"></div>
          <div class="so-noul-fill so-noul-fill--true" style="width: ${b(t)}"></div>
        </div>
        <span class="so-noul-label so-noul-label--true">${b(t)} true</span>
      </div>
    </div>
  `}function Et(s,e){let t=e.probabilities||{},a=e.choice,n=Object.entries(t).sort((i,o)=>o[1]-i[1]);return r`
    <div class="so-answer">
      <div class="so-answer-title">${s} → <strong>${a}</strong>
        <span class="so-confidence" title="Distribution concentration (1 − H(p)/ln(N)); not calibrated correctness">conf ${b(Number(e.confidence)||0)}</span>
      </div>
      <div class="so-choice">
        ${n.map(([i,o])=>r`
            <div class="so-choice-row${i===a?" so-choice-row--winner":""}">
              <span class="so-choice-opt">${i}</span>
              <div class="so-choice-track">
                <div class="so-choice-fill" style="width: ${b(Number(o)||0)}"></div>
              </div>
              <span class="so-choice-pct">${b(Number(o)||0)}</span>
            </div>
          `)}
      </div>
    </div>
  `}function St(s,e){let t=e.legend||{},a=e.probabilities||{},n=Object.keys(t),i=n.length,o=Number(e.score)||0,c=i>1?Math.min(1,Math.max(0,o/(i-1))):0;return r`
    <div class="so-answer">
      <div class="so-answer-title">${s} → <strong>score ${o.toFixed(2)}</strong>
        <span class="so-confidence" title="Distribution concentration (1 − H(p)/ln(N)); not calibrated correctness">conf ${b(Number(e.confidence)||0)}</span>
      </div>
      <div class="so-score">
        <div class="so-score-track">
          <div class="so-score-marker" style="left: ${b(c)}"></div>
        </div>
        <div class="so-score-legend">
          ${n.map(l=>r`
              <span class="so-score-criterion">
                <span class="so-score-idx">${l}</span> ${t[l]}
                <span class="so-choice-pct">${b(Number(a[l])||0)}</span>
              </span>
            `)}
        </div>
      </div>
    </div>
  `}function At(s){let e=Object.entries(s||{});return e.length?r`
    <div class="so-answers">
      ${e.map(([t,a])=>!a||typeof a!="object"?null:a.type==="noul"?xt(t,a):a.type==="choice"?Et(t,a):a.type==="score"?St(t,a):null)}
    </div>
  `:null}function Ct(s){let e=/```json\n?([\s\S]*?)```/.exec(s.content||"");if(!e)return null;let t;try{t=JSON.parse(e[1])}catch{return null}let a=At(t);return a?r`
    <div class="msg-body-inner msg-body-inner--dom">
      ${a}
      <details class="msg-system-details so-raw-details">
        <summary class="msg-system-summary">Raw JSON</summary>
        <pre class="msg-code-block"><code class="language-json">${JSON.stringify(t,null,2)}</code></pre>
      </details>
    </div>
  `:null}function Ge(s){if(!s)return r`<div class="empty">No request selected.</div>`;if(!s.messageList?.length)return s.endpointType==="audio"&&s.audio?.path?r`
        <div class="message-thread">
          <div class="audio-preview">
            <audio controls preload="metadata" src=${`/admin/audio/${s.requestId}`}></audio>
          </div>
        </div>
      `:r`<div class="preview-box">
      ${oe(s)||"No preview available."}
    </div>`;let e=s.endpointType==="systemone",t=s.messageList,a=s.status==="waiting"||s.status==="running";return r`
    <div class="message-thread">
      ${s.endpointType==="audio"&&s.audio?.path?r`
            <div class="msg msg--user">
              <div class="msg-header">
                <span class="msg-avatar msg-avatar--user">U</span>
                <span class="msg-role">${Ne.user??"User"}</span>
                <span class="msg-index">#0</span>
              </div>
              <div class="msg-body">
                <div class="audio-preview">
                  <audio controls preload="metadata" src=${`/admin/audio/${s.requestId}`}></audio>
                </div>
              </div>
            </div>
          `:""}
      ${t.map((n,i)=>{let o=i===t.length-1,c=a&&o&&n.role==="assistant";return r`
          <div class="msg msg--${n.role}">
            <div class="msg-header">
              <span class="msg-avatar msg-avatar--${n.role}">
                ${n.role==="tool"?r`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`:n.role.charAt(0).toUpperCase()}
              </span>
              <span class="msg-role">
                ${Ne[n.role]??n.role}
              </span>
              ${n.name?r`<span class="msg-fn-name">${n.name}</span>`:""}
              <span class="msg-index">#${i+1}</span>
            </div>
            <div class="msg-body">
              ${e&&n.role==="assistant"?Ct(n)??Oe(n,t,c):Oe(n,t,c)}
            </div>
          </div>
        `})}
    </div>
  `}var le=class extends f{static properties={summary:{attribute:!1}};constructor(){super(),this.summary={online:0,totalNodes:0,totalModels:0,totalReqs:0,avgLat:0,avgTps:0}}createRenderRoot(){return this}render(){return r`
      <div class="summary">
        <div class="stat">
          <div class="stat-label">Nodes Online</div>
          <div class="stat-val green">${this.summary.online||"\u2014"}</div>
          <div class="stat-sub">of ${this.summary.totalNodes} configured</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Models</div>
          <div class="stat-val blue">${this.summary.totalModels||"\u2014"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Active Requests</div>
          <div
            class="stat-val ${this.summary.totalReqs>0?"yellow":"blue"}"
          >
            ${this.summary.totalReqs||0}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Average Latency</div>
          <div
            class="stat-val ${this.summary.avgLat>0?F(this.summary.avgLat):"muted"}"
          >
            ${p.duration(this.summary.avgLat)}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">
            Average <abbr title="Tokens Per Second">TPS</abbr>
          </div>
          <div
            class="stat-val ${this.summary.avgTps>0?"blue":"muted stat-val-empty"}"
          >
            ${p.tps(this.summary.avgTps)}
          </div>
        </div>
      </div>
    `}};globalThis.customElements.define("dashboard-summary",le);var de=class extends f{static properties={node:{attribute:!1},forcedModel:{attribute:!1},cloudUsage:{attribute:!1},_removing:{state:!0},_removeError:{state:!0},_waking:{state:!0},_wakeError:{state:!0},_wakeSuccess:{state:!0},_cloudAvailable:{state:!0},_cloudLoading:{state:!0},_cloudError:{state:!0},_cloudMutating:{state:!0},_collapsed:{state:!0},_forcingModel:{state:!0},_forceError:{state:!0},_togglingModel:{state:!0}};constructor(){super(),this.node=null,this.forcedModel=null,this.cloudUsage=null,this._removing=!1,this._removeError="",this._waking=!1,this._wakeError="",this._wakeSuccess=!1,this._cloudAvailable=[],this._cloudLoading=!1,this._cloudError="",this._cloudMutating=!1,this._collapsed=!1,this._forcingModel="",this._forceError="",this._togglingModel="",this._lastKnownModels={},this._collapseInitialized=!1}_toggleCollapsed(){this._collapsed=!this._collapsed}createRenderRoot(){return this}updated(e){e.has("node")&&this.node&&!this._collapseInitialized&&(this._collapseInitialized=!0,this._collapsed=!this.node.reachable)}connectedCallback(){super.connectedCallback(),this.node?.cloud&&this._fetchCloudAvailable()}async _onRemove(){if(!(this._removing||!this.node)){this._removing=!0,this._removeError="";try{let e=await fetch(`/admin/inventory/nodes/${encodeURIComponent(this.node.host)}`,{method:"DELETE"});if(!e.ok){let t=await e.json().catch(()=>({}));throw new Error(t.error??e.statusText)}this.dispatchEvent(new CustomEvent("node-removed",{bubbles:!0,composed:!0,detail:{host:this.node.host}}))}catch(e){this._removeError=e.message,setTimeout(()=>{this._removeError=""},4e3)}finally{this._removing=!1}}}async _onWake(){if(!(this._waking||!this.node)){this._waking=!0,this._wakeError="",this._wakeSuccess=!1;try{let e=await fetch(`/admin/inventory/nodes/${encodeURIComponent(this.node.host)}/wake`,{method:"POST"});if(!e.ok){let t=await e.json().catch(()=>({}));throw new Error(t.error??e.statusText)}this._wakeSuccess=!0,setTimeout(()=>{this._wakeSuccess=!1},5e3),this.dispatchEvent(new CustomEvent("node-wake-triggered",{bubbles:!0,composed:!0,detail:{host:this.node.host}}))}catch(e){this._wakeError=e.message,setTimeout(()=>{this._wakeError=""},5e3)}finally{this._waking=!1}}}async _fetchCloudAvailable(){this._cloudLoading=!0,this._cloudError="";try{let e=await fetch("/admin/cloud/models");if(!e.ok)throw new Error((await e.json().catch(()=>({}))).error??e.statusText);let t=await e.json();this._cloudAvailable=t.available??[]}catch(e){this._cloudError=e.message}finally{this._cloudLoading=!1}}async _addModel(e){if(!(!e||this._cloudMutating)){this._cloudMutating=!0;try{let t=await fetch("/admin/cloud/models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e})});if(!t.ok)throw new Error((await t.json().catch(()=>({}))).error??t.statusText);await this._fetchCloudAvailable()}catch(t){this._cloudError=t.message,setTimeout(()=>{this._cloudError=""},4e3)}finally{this._cloudMutating=!1}}}async _removeModel(e){if(!this._cloudMutating){this._cloudMutating=!0;try{let t=await fetch(`/admin/cloud/models/${encodeURIComponent(e)}`,{method:"DELETE"});if(!t.ok)throw new Error((await t.json().catch(()=>({}))).error??t.statusText);await this._fetchCloudAvailable()}catch(t){this._cloudError=t.message,setTimeout(()=>{this._cloudError=""},4e3)}finally{this._cloudMutating=!1}}}_onDropdownChange(e){let t=e.target.value;t&&(e.target.value="",this._addModel(t))}async _toggleDisabled(e,t){if(!(this._togglingModel||!this.node)){this._togglingModel=e;try{let a=await fetch(`/admin/inventory/nodes/${encodeURIComponent(this.node.host)}/models/${encodeURIComponent(e)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({disabled:!t})});if(!a.ok){let n=await a.json().catch(()=>({}));throw new Error(n.error??a.statusText)}this.dispatchEvent(new CustomEvent("model-disabled-changed",{bubbles:!0,composed:!0,detail:{host:this.node.host,name:e,disabled:!t}}))}catch(a){this._forceError=a.message,setTimeout(()=>{this._forceError=""},4e3)}finally{this._togglingModel=""}}}async _forceModel(e){if(!this._forcingModel){this._forcingModel=e,this._forceError="";try{let t=await fetch("/admin/force-model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:e})}),a=await t.json().catch(()=>({}));if(!t.ok)throw new Error(a.error??t.statusText);this.dispatchEvent(new CustomEvent("force-model-set",{bubbles:!0,composed:!0,detail:{model:a.model,expiresAt:a.expiresAt}}))}catch(t){this._forceError=t.message,setTimeout(()=>{this._forceError=""},4e3)}finally{this._forcingModel=""}}}async _cancelForceModel(){if(!this._forcingModel){this._forcingModel="__cancel__";try{let e=await fetch("/admin/force-model",{method:"DELETE"});if(!e.ok)throw new Error(e.statusText);this.dispatchEvent(new CustomEvent("force-model-cleared",{bubbles:!0,composed:!0}))}catch(e){this._forceError=e.message,setTimeout(()=>{this._forceError=""},4e3)}finally{this._forcingModel=""}}}_renderCloudFooter(e){let t=this.cloudUsage,a=o=>o>=90?"danger":o>=70?"warn":"",n=this._cloudAvailable.filter(o=>!e.has(o.name)).sort((o,c)=>o.name.localeCompare(c.name)),i=this._cloudLoading?"Loading models\u2026":n.length===0?"No more models available":"+ Add cloud model\u2026";return r`
      <div class="cloud-usage-footer">
        <div class="cloud-add-wrap">
          ${this._cloudError?r`<span class="cloud-add-error">${this._cloudError}</span>`:""}
          <select
            class="cloud-add-select"
            ?disabled=${this._cloudMutating||this._cloudLoading}
            @change=${this._onDropdownChange}
          >
            <option value="">${i}</option>
            ${n.map(o=>r`<option value=${o.name}>${o.name}</option>`)}
          </select>
        </div>
        ${t?r`
              <div class="cloud-usage-bars">
                <div class="usage-bar-row">
                  <span class="usage-label">Session</span>
                  <div class="usage-track">
                    <div
                      class="usage-fill ${a(t.sessionPct)}"
                      style="width:${t.sessionPct}%"
                    ></div>
                  </div>
                  <span class="usage-pct ${a(t.sessionPct)}"
                    >${t.sessionPct}%</span
                  >
                  <span class="usage-reset muted"
                    >↺ ${p.countdown(t.sessionResetMs)}</span
                  >
                </div>
                <div class="usage-bar-row">
                  <span class="usage-label">Weekly</span>
                  <div class="usage-track">
                    <div
                      class="usage-fill ${a(t.weeklyPct)}"
                      style="width:${t.weeklyPct}%"
                    ></div>
                  </div>
                  <span class="usage-pct ${a(t.weeklyPct)}"
                    >${t.weeklyPct}%</span
                  >
                  <span class="usage-reset muted"
                    >↺ ${p.countdown(t.weeklyResetMs)}</span
                  >
                </div>
              </div>
            `:""}
      </div>
    `}_renderModelTable(e,{isCloud:t,isEmbedding:a,isDecision:n,activeNames:i}){if(e.length===0)return"";let o=a?"Dim":n?"OPTS":"TPS",c=[t?"cloud-table":"",a?"embed-table":""].filter(Boolean).join(" ");return r`
      <div class="models-wrap">
        <table class="${c}">
          <colgroup>
            <col class="c-model" />
            ${t?"":r`<col class="c-size" />`}
            <col class="c-params" />
            <col class="c-ctx" />
            <col class="c-latency" />
            <col class="c-tps" />
            <col class="c-reqs" />
            <col class="c-lastused" />
            <col class="c-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Model</th>
              ${t?"":r`<th>Size</th>`}
              <th>Params</th>
              <th>Ctx</th>
              <th title="Time to first token (EMA over recent requests)">TTFT</th>
              <th
                title=${n?"Max SystemOne choice criteria per question, learned from upstream caps":"Decoding speed (tokens/s), excluding model load"}
                >${o}</th
              >
              <th>Req/Fails</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${e.map(l=>this._renderModelRow(l,{isCloud:t,isEmbedding:a,isDecision:n}))}
          </tbody>
        </table>
      </div>
    `}_renderModelRow(e,{isCloud:t,isEmbedding:a,isDecision:n}){return r`
      <tr
        class="${e.activeRequests>0?"model-active":""} ${e.disabled?"model-disabled":""} ${this.forcedModel===e.name?"model-forced":""}"
      >
        <td class="td-model">
          <div class="model-name">
            ${this.forcedModel===e.name?r`<span
                  class="model-forced-pin"
                  title="Pinned for next request"
                  >▶</span
                >`:""}
            ${e.activeRequests>0?r`<span
                  class="model-active-dot"
                  title="${e.activeRequests} request(s) running"
                ></span>`:""}
            ${e.name}
          </div>
          <div class="model-fam">${e.family||"\u2014"}</div>
          <div class="model-caps">${Be(e.profile)}</div>
        </td>
        ${t?"":r`<td class="mono">${p.bytes(e.size)}</td>`}
        <td class="mono">${p.params(e.profile?.parameters)}</td>
        <td class="mono">${p.ctx(e.profile?.contextLength)}</td>
        <td>
          ${(()=>{let i=e.recentTtft>0,o=i?e.recentTtft:e.recentLatency,c=i?`First token after ${p.duration(o)} \xB7 model load ~${p.duration(e.recentLoadMs)}`:"Recent response latency (legacy metric, TTFT pending)";return r`<span class="mono ${F(o)}"
              title=${c}>${p.duration(o)}</span
            >`})()}
        </td>
        <td class="mono">
          ${(()=>{if(a)return e.profile?.embeddingDim||"\u2014";if(n){let i=e.systemoneMaxCriteria||0;return r`<span class="mono ${i?"":"muted"}"
                >${i?`\u2264${i}`:"\u2014"}</span
              >`}return r`<span
                class="mono ${p.tps(e.recentTps)==="\u2014"?"muted":""}"
                title="Decoding speed (tokens/s), excluding model load"
                >${p.tps(e.recentTps)}</span
              >`})()}
        </td>
        <td class="mono">
          ${e.totalRequests||0}<span class="muted">/</span
          ><span class="${e.failures>0?"bad":"muted"}"
            >${e.failures||0}</span
          >
        </td>
        <td
          class="mono muted"
          title="${e.lastRoutedAt?new Date(e.lastRoutedAt).toLocaleString():"Never used"}"
        >
          ${p.ago(e.lastRoutedAt)}
        </td>
        <td class="td-action">
          <div class="td-action-inner">
            ${a?"":r`
                  <button
                    class="btn-force-model ${this.forcedModel===e.name?"is-active":""}"
                    title="${this.forcedModel===e.name?"Cancel force override for "+e.name:"Force "+e.name+" for the next request"}"
                    ?disabled=${!this.node.reachable||e.disabled||this._forcingModel!==""}
                    @click=${()=>this.forcedModel===e.name?this._cancelForceModel():this._forceModel(e.name)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="12" y1="6" x2="21" y2="6" />
                      <line x1="12" y1="12" x2="21" y2="12" />
                      <line x1="12" y1="18" x2="21" y2="18" />
                      <path d="M4 14 V 9 a 3 3 0 0 1 3 -3 h 5" />
                      <polyline points="9 3 12 6 9 9" />
                    </svg>
                  </button>
                `}
            <button
              class="btn-toggle-disabled"
              title="${e.disabled?"Enable "+e.name+" on this node":"Disable "+e.name+" on this node (router will skip it)"}"
              ?disabled=${this._togglingModel===e.name}
              @click=${()=>this._toggleDisabled(e.name,!!e.disabled)}
              style="${t?"display:none":""}"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                ${e.disabled?ie`<polygon points="7 4 20 12 7 20 7 4" />`:ie`<rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />`}
              </svg>
            </button>
            ${t?r`
                  <button
                    class="btn-cloud-remove"
                    title="Remove ${e.name} from cloud node"
                    ?disabled=${this._cloudMutating}
                    @click=${()=>this._removeModel(e.name)}
                  >
                    ✕
                  </button>
                `:""}
          </div>
        </td>
      </tr>
    `}render(){if(!this.node)return r``;let e=this.node.models||{};this.node.reachable&&Object.keys(e).length>0&&(this._lastKnownModels=e);let t=Object.keys(e).length>0?e:this._lastKnownModels,a=Object.values(t),n=a.filter($=>!$.profile?.isEmbedding&&!$.profile?.supportsDecision),i=a.filter($=>$.profile?.supportsDecision&&!$.profile?.isEmbedding),o=a.filter($=>$.profile?.isEmbedding),c=this.node.host.replace(/^https?:\/\//,""),l=!!this.node.cloud,d=new Set(a.map($=>$.name)),u=this.node.reachable?"ok":"err",h=this.cloudUsage?.plan??null,m=!this.node.reachable&&!!this.node.mac&&!l,g=h?`\u2601\uFE0F  Cloud \u30FB${h}`:"\u2601\uFE0F  Cloud",y=h==="Max"?"b-purple":h==="Pro"?"b-green":"b-blue";return r`
      <div class="node-card ${u}">
        <div class="node-header">
          <button
            class="node-summary"
            type="button"
            aria-expanded=${!this._collapsed}
            @click=${this._toggleCollapsed}
          >
            <div class="node-title">
              <div class="node-dot ${this.node.reachable?"ok":"err"}"></div>
              <span class="node-host">${c}</span>
            </div>
            <div class="node-badges">
              ${l?r`<span class="badge ${y}"
                    >${g}</span
                  >`:""}
              <span class="badge ${this.node.reachable?"b-green":"b-red"}">
                ${this.node.reachable?"Online":"Offline"}
              </span>
              ${this.node.activeRequests>0?r`<span class="badge b-blue"
                    >${this.node.activeRequests} active</span
                  >`:""}
              ${Number.isFinite(this.node.maxConcurrentRequests)?r`<span
                    class="badge ${this.node.atCapacity?"b-red":""}"
                  >
                    ${this.node.activeRequests||0}/${this.node.maxConcurrentRequests}
                  </span>`:""}
              <span class="badge">
                ${a.length} model${a.length===1?"":"s"}
              </span>
            </div>
          </button>

          <div class="node-actions">
            ${m?r`
                  <button
                    class="node-action-btn node-action-wake ${this._waking?"waking":""} ${this._wakeSuccess?"wake-ok":""}"
                    title="Send Wake-on-LAN magic packet to ${this.node.mac}"
                    aria-label="Wake node"
                    ?disabled=${this._waking}
                    @click=${this._onWake}
                  >
                    ${this._waking?r`<span class="node-action-spinner"></span>`:r`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`}
                  </button>
                  ${this._wakeError?r`<span class="wake-error">${this._wakeError}</span>`:""}
                  ${this._wakeSuccess?r`<span class="wake-success">Packet sent!</span>`:""}
                `:""}
            ${l?"":r`
                  <button
                    class="node-action-btn node-action-remove"
                    title="Remove node from inventory"
                    aria-label="Remove node"
                    ?disabled=${this._removing}
                    @click=${this._onRemove}
                  >
                    ${this._removing?r`<span class="node-action-spinner"></span>`:r`<svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path
                            d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
                          />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>`}
                  </button>
                  ${this._removeError?r`<span class="remove-error"
                        >${this._removeError}</span
                      >`:""}
                `}
            <button
              class="node-action-btn node-action-collapse"
              type="button"
              aria-label=${this._collapsed?"Expand node":"Collapse node"}
              @click=${this._toggleCollapsed}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                style="transition: transform 0.2s; transform: rotate(${this._collapsed?"-90deg":"0deg"})"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        ${this._collapsed?"":r`
              ${this._forceError?r`<div class="force-error-banner">
                    ${this._forceError}
                  </div>`:""}
              ${a.length===0&&!l?r`
                    <div class="node-empty-state">
                      <span class="node-empty-icon">📢</span>
                      <span class="node-empty-text">No models discovered</span>
                      <span class="node-empty-sub">
                        ${this.node.reachable?"Node online but no models loaded.":"Node offline."}
                      </span>
                    </div>
                  `:r`
                    ${n.length>0?this._renderModelTable(n,{isCloud:l,isEmbedding:!1,isDecision:!1,activeNames:d}):""}
                    ${i.length>0?r`
                          <div class="models-section-header">
                            Decision models
                          </div>
                          ${this._renderModelTable(i,{isCloud:l,isEmbedding:!1,isDecision:!0,activeNames:d})}
                        `:""}
                    ${o.length>0?r`
                          <div class="models-section-header">
                            Embedding models
                          </div>
                          ${this._renderModelTable(o,{isCloud:l,isEmbedding:!0,activeNames:d})}
                        `:""}
                  `}
              ${l?this._renderCloudFooter(d):""}
            `}
      </div>
    `}};globalThis.customElements.define("node-card",de);var kt=new Set(["auto","auto-fast","auto-think","auto-local"]),ce=class extends f{static properties={open:{type:Boolean},request:{attribute:!1},expandedCandidates:{state:!0}};constructor(){super(),this.open=!1,this.request=null,this.expandedCandidates=new Set}updated(){this.open&&this.request&&this.dispatchEvent(new Event("syntax-highlight",{bubbles:!0,composed:!0}))}createRenderRoot(){return this}emitClose(){this.dispatchEvent(new CustomEvent("drawer-close",{bubbles:!0,composed:!0}))}async handleTerminate(){if(this.request)try{await fetch(`/admin/requests/${encodeURIComponent(this.request.requestId)}`,{method:"DELETE"})}catch{}}candidateKey(e,t){return`${e}@${t}`}toggleCandidate(e){let t=new Set(this.expandedCandidates);t.has(e)?t.delete(e):t.add(e),this.expandedCandidates=t}selectedModelLabel(){return this.request?this.request.selectedModel||this.request.candidates?.[0]?.modelName||W(this.request):"\u2014"}buildRoutingPath(e,t){let a=new Set,n=e.map(o=>{let c=t.findIndex((d,u)=>!a.has(u)&&d.modelName===o.modelName&&d.nodeHost===o.nodeHost),l=c!==-1?t[c]:null;return c!==-1&&a.add(c),{candidate:o,attempt:l}}),i=t.filter((o,c)=>!a.has(c)).map(o=>({candidate:null,attempt:o}));return[...n,...i]}selectedCandidate(){if(!this.request)return null;let e=this.request.candidates||[],t=this.request.selectedModel,a=this.request.selectedNode;return t?e.find(n=>n.modelName===t&&(!a||n.nodeHost===a))??e[0]??null:e[0]??null}renderCandidateCard({candidate:e,attempt:t},a){let n=e?.modelName??t?.modelName??"\u2014",i=e?.nodeHost??t?.nodeHost??"",o=e?.score??null,c=this.request?.status,d=a&&(c==="waiting"||c==="running")?c:t?.status??(a?c??null:null),u=this.candidateKey(n,i),h=this.expandedCandidates.has(u)||a&&!this.expandedCandidates.has(`__collapsed_${u}`),m="b-muted",g="Skipped";a?d==="success"?(m="b-green",g="Success"):d==="running"?(m="b-blue",g="Running"):d==="waiting"?(m="b-yellow",g="Waiting"):d?(m="b-red",g=p.status(d)):(m="b-blue",g="Selected"):d&&(d==="success"?(m="b-green",g="Success"):d==="capacity"?(m="b-yellow",g="Capacity"):(m="b-red",g=p.status(d)));let y=e?.rationale?Ke(e,this.request?.candidates?.[0]):o!==null?r`<div class="cand-score-only">${o.toFixed(1)}</div>`:"",$=e?.rationale?.ranking,Xe=$&&$.rank>1&&$.gap<0?r`<span class="rd-neg cand-gap" title="Deficit to the top-ranked candidate">−${Math.abs($.gap).toFixed(1)}</span>`:"";return r`
      <div class="cand-card ${a?"winner":""} ${h?"open":""}">
        <div class="cand-header"
          @click=${()=>{a&&!this.expandedCandidates.has(u)&&(this.expandedCandidates=new Set([...this.expandedCandidates,`__collapsed_${u}`])),this.toggleCandidate(u)}}
        >
          <div class="cand-line1">
            <span class="cand-model mono">${n}</span>
            <span class="badge ${m}">${g}</span>
          </div>
          <div class="cand-line2">
            <span class="cand-ip">${i}</span>
            <div class="cand-meta">
              ${o!==null?r`<span class="cand-score-label">score</span>
                       <span class="cand-score-val ${a?"winner":""}">${o.toFixed(1)}</span>`:""}
              ${Xe}
              <span class="cand-expand">▸</span>
            </div>
          </div>
        </div>
        <div class="cand-detail">
          ${y}
        </div>
      </div>
    `}renderMissingModelCard(e){return r`
      <div class="cand-card" style="opacity:0.6">
        <div class="cand-header" style="cursor:default">
          <div class="cand-line1">
            <span class="cand-model mono">${e}</span>
            <span class="badge b-red">Not found</span>
          </div>
          <div class="cand-line2">
            <span class="cand-ip muted">originally requested — rerouted to auto</span>
          </div>
        </div>
      </div>
    `}renderLatencyTimeline(e){if(!e)return"";let t=e.latency||0;if(t<=0)return"";let a=[],n=Math.max(0,e.queueWaitMs||0),i=Math.max(0,e.modelLoadMs||0),o=Math.max(0,e.executionTimeMs||t-n-i),c=0,l=(d,u,h)=>{if(u<=0||t<=0)return;let m=Math.max(2,u/t*100);a.push({label:d,value:u,pct:m,color:h})};return l("Queue",n,"var(--accent)"),l("Load",i,"var(--warning, #f59e0b)"),l("Exec",o,"var(--success, #10b981)"),a.length===0?"":r`
      <div class="latency-timeline" title="Queue + Load + Exec = Total latency">
        ${a.map(d=>r`
            <div
              class="lt-seg"
              style="width:${d.pct}%;background:${d.color}"
              aria-label="${d.label} ${p.duration(d.value)}"
            ></div>
          `)}
      </div>
      <div class="latency-legend">
        ${a.map(d=>r`
            <span class="lt-item"><span class="lt-dot" style="background:${d.color}"></span>${d.label} ${p.duration(d.value)}</span>
          `)}
      </div>
    `}renderRoutingSection(){if(!this.request)return"";let e=this.request.candidates||[],t=this.request.attempts||[];if(!e.length&&!t.length)return"";let a=this.buildRoutingPath(e,t),n=this.request.selectedModel,i=this.request.selectedNode,o=this.request.requestedModel,c=this.request.status==="waiting"||this.request.status==="running",l=n&&o&&n!==o&&!kt.has(o);return r`
      <div class="detail-section">
        <div class="section-title-row">
          <h3>Routing Decision</h3>
          ${a.length>1?r`<span class="section-count">${a.length} candidates</span>`:""}
        </div>
        ${Ve(e)}
        ${Je(e,e[0]?this.candidateKey(e[0].modelName,e[0].nodeHost):"")}
        <div class="candidate-list">
          ${a.map(({candidate:d,attempt:u},h)=>{let m=d?.modelName??u?.modelName,g=d?.nodeHost??u?.nodeHost,y=n?m===n&&(!i||g===i):c&&h===0;return this.renderCandidateCard({candidate:d,attempt:u},y)})}
          ${l?this.renderMissingModelCard(o):""}
        </div>
      </div>
    `}renderExecutionSection(){if(!this.request)return"";let e=this.request;return r`
      <div class="detail-section">
        <h3>Execution</h3>
        <div class="metadata-compact">
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Latency</div>
              <div class="metadata-value">
                ${p.duration(e.latency)}
              </div>
              ${this.renderLatencyTimeline(e)}
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Signals</div>
              <div class="metadata-value">
                ${ze(e.analysis||{})}
              </div>
            </div>
          </div>
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Tokens in</div>
              <div class="metadata-value">${e.tokensPrompt??"\u2014"}</div>
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Tokens out</div>
              <div class="metadata-value">${e.tokensGenerated??0}</div>
            </div>
          </div>
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Input</div>
              <div class="metadata-value">${e.inputSummary||"\u2014"}</div>
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Stream</div>
              <div class="metadata-value">${e.stream?"Yes":"No"}</div>
            </div>
          </div>
          <div class="metadata-row span-all">
            <div class="metadata-col">
              <div class="metadata-label">Model load</div>
              <div class="metadata-value">
                ${e.modelLoadMs>0?p.duration(e.modelLoadMs):"\u2014"}
                ${e.modelLoadMs>0?r`<span class="muted">time to load model into memory</span>`:""}
              </div>
            </div>
          </div>
        </div>
      </div>
    `}renderActionableInsights(){if(!this.request)return"";let e=!!this.request.abortReason,t=!!this.request.failureCategory,a=!!this.request.retryHint;return!e&&!t&&!a?"":r`
      <div class="detail-section">
        <h3>Insights</h3>
        <div class="detail-list">
          ${e?r`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Abort reason</div>
                  <div class="detail-row-sub">${Pe(this.request.abortReason)}</div>
                </div>
              </div>`:""}
          ${t?r`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Failure category</div>
                  <div class="detail-row-sub">${Le(this.request.failureCategory)}</div>
                </div>
              </div>`:""}
          ${a?r`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Recommended action</div>
                  <div class="detail-row-sub">${Ie(this.request.retryHint)}</div>
                </div>
              </div>`:""}
        </div>
      </div>
    `}renderRequestDetails(){return this.request?r`
      ${this.renderRoutingSection()}
      ${this.renderExecutionSection()}
      ${this.renderActionableInsights()}

      <div class="detail-section">
        <h3>Conversation</h3>
        <div class="conversation-scroll">
          ${Ge(this.request)}
        </div>
      </div>

      ${this.request.error?r`
            <div class="detail-section error-section">
              <h3>Error</h3>
              <div class="preview-box error-box">${this.request.error}</div>
            </div>
          `:""}
    `:r`<div class="empty">Select a request from the list.</div>`}render(){let e=this.request&&(this.request.status==="running"||this.request.status==="waiting");return r`
      <div
        class="drawer-shell ${this.open?"open":""}"
        aria-hidden=${this.open?"false":"true"}
      >
        <div class="drawer-backdrop" @click=${()=>this.emitClose()}></div>
        <aside class="drawer">
          <div class="drawer-head">
            <div>
              <div class="drawer-title">Request Details</div>
              <div class="drawer-subtitle">
                ${this.request?`${z(this.request.endpointType)} \xB7 ${this.request.requestId}`:"Select a request from the list."}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem">
              ${e?r`<button
                    class="drawer-terminate-btn"
                    type="button"
                    title="Terminate this request"
                    @click=${()=>this.handleTerminate()}
                  >Terminate</button>`:""}
              <button
                class="drawer-close"
                type="button"
                @click=${()=>this.emitClose()}
              >✕</button>
            </div>
          </div>
          <div class="drawer-body">${this.renderRequestDetails()}</div>
        </aside>
      </div>
    `}};globalThis.customElements.define("unified-request-drawer",ce);function Mt(s=[]){let e=s.filter(n=>n.status==="running").length,t=s.filter(n=>n.status==="waiting").length,a=s.filter(n=>n.status==="failed"||n.status==="rejected").length;return r`
    <span class="badge b-blue">${s.length} tracked</span>
    <span class="badge ${e>0?"b-yellow":""}">${e} running</span>
    <span class="badge ${t>0?"b-yellow":""}">${t} waiting</span>
    <span class="badge ${a>0?"b-red":""}">${a} failed</span>
  `}var ue=class extends f{static properties={requests:{attribute:!1},selectedRequestId:{attribute:!1},drawerOpen:{type:Boolean},collapsed:{state:!0},page:{state:!0}};constructor(){super(),this.requests=[],this.selectedRequestId=null,this.drawerOpen=!1,this.collapsed=!1,this.page=0}createRenderRoot(){return this}handleSelect(e){this.dispatchEvent(new CustomEvent("request-selected",{detail:{requestId:e},bubbles:!0,composed:!0}))}async handleTerminate(e,t){t.stopPropagation();try{await fetch(`/admin/requests/${encodeURIComponent(e)}`,{method:"DELETE"})}catch{}}toggleCollapsed(){this.collapsed=!this.collapsed,this.collapsed||(this.page=0)}prevPage(){this.page=Math.max(0,this.page-1)}nextPage(e){this.page=Math.min(e-1,this.page+1)}renderRequestRow(e){let t=e.status==="running"||e.status==="waiting",a=e.status==="success"?"b-green":e.status==="waiting"?"b-yellow":e.status==="running"?"b-blue":"b-red",n=je(e),i=e.status==="waiting"?Math.max(0,Date.now()-(e.createdAt||Date.now())):0,o=this.drawerOpen&&this.selectedRequestId===e.requestId,c=He(e),l=De(e);return r`
      <div class="request-row ${o?"active":""}">
        <button
          class="request-row-main"
          type="button"
          @click=${()=>this.handleSelect(e.requestId)}
        >
          <!-- Status dot -->
          <span class="request-status ${Ue(e.status)}"></span>

          <!-- Main content -->
          <span class="request-main">
            <span class="request-topline">
              <span class="badge">${z(e.endpointType)}</span>
              ${c?r`<span class="badge b-blue" title="Routed to ollama.com cloud">☁ cloud</span>`:""}
              <span class="request-route">${e.requestedModel||"auto"}</span>
              <span class="mono request-target">→ ${W(e)}</span>
            </span>
            ${l?r`<span class="request-inline-error" title=${l}>${l.length>80?l.slice(0,79)+"\u2026":l}</span>`:r`<span class="request-preview">${oe(e)}</span>`}
            <span class="request-meta">
              ${n.map((d,u)=>r`
                ${u>0?r`<span class="request-meta-dot"></span>`:""}
                <span class="request-meta-item">${d}</span>
              `)}
            </span>
          </span>

          <!-- Side: badge + timing -->
          <span class="request-side">
            <span class="request-side-top">
              <span class="badge ${a}">${p.status(e.status)}</span>
            </span>
            <span class="request-side-bottom">
              ${i>0?r`<span class="mono muted">waiting ${p.duration(i)}</span>`:""}
              ${e.queueWaitMs>0&&e.status!=="waiting"?r`<span class="mono muted">queue ${p.duration(e.queueWaitMs)}</span>`:""}
              ${e.latency>0?r`<span class="mono muted">took ${p.duration(e.latency)}</span>`:""}
              <span class="mono muted">${p.ago(e.finishedAt||e.createdAt)}</span>
            </span>
          </span>
        </button>

        ${t?r`
              <button
                class="request-terminate-btn"
                type="button"
                title="Terminate request"
                @click=${d=>this.handleTerminate(e.requestId,d)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2.5"
                  stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            `:""}
      </div>
    `}render(){let e=Math.max(1,Math.ceil(this.requests.length/B));this.page>=e&&(this.page=e-1);let t=this.page*B,a=this.requests.slice(t,t+B);return r`
      <section class="requests-shell panel">
        <!--
          Panel head mirrors node-card header layout:
            row 1: [title .................. chevron]
            row 2: [badges                         ]
        -->
        <button
          class="panel-head panel-head--btn"
          type="button"
          @click=${this.toggleCollapsed}
        >
          <div class="panel-head-inner">
            <div class="panel-head-top">
              <span class="panel-title">Recent Requests</span>
              <span
                class="panel-collapse-icon"
                style="transform:rotate(${this.collapsed?"-90deg":"0deg"})"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </span>
            </div>
            <div class="panel-head-badges">
              ${Mt(this.requests)}
            </div>
          </div>
        </button>

        ${this.collapsed?"":r`
          <div class="request-list">
            ${a.length?a.map(n=>this.renderRequestRow(n)):r`<div class="empty">No requests received yet.</div>`}
          </div>
          ${e>1?r`
            <div class="request-pager">
              <button class="pager-btn" type="button"
                ?disabled=${this.page===0}
                @click=${()=>this.prevPage()}>&#8249;</button>
              <span class="pager-label">${this.page+1} / ${e}</span>
              <button class="pager-btn" type="button"
                ?disabled=${this.page===e-1}
                @click=${()=>this.nextPage(e)}>&#8250;</button>
            </div>
          `:""}
        `}
      </section>
    `}};globalThis.customElements.define("request-panel",ue);var he=class extends f{static properties={wsState:{state:!0},payload:{state:!0},selectedRequestId:{state:!0},drawerOpen:{state:!0},scanInProgress:{state:!0},rescanMessage:{state:!0},_forceOverride:{state:!0},_clearingOverride:{state:!0}};constructor(){super(),this.wsState="connecting",this.payload={timestamp:0,nodes:{},requests:[],scan:{},cloudUsage:null},this.selectedRequestId=null,this.drawerOpen=!1,this.scanInProgress=!1,this.rescanMessage="",this._forceOverride=null,this._clearingOverride=!1,this.ws=null,this.retryTimer=null}updated(){this.dispatchEvent(new Event("syntax-highlight",{bubbles:!0,composed:!0}))}createRenderRoot(){return this}connectedCallback(){super.connectedCallback(),this.connect(),this.addEventListener("force-model-set",e=>{this._forceOverride={model:e.detail.model,expiresAt:e.detail.expiresAt}}),this.addEventListener("force-model-cleared",()=>{this._forceOverride=null})}disconnectedCallback(){super.disconnectedCallback(),this.retryTimer&&clearTimeout(this.retryTimer),this.ws&&this.ws.close()}connect(){let e=globalThis.location.protocol==="https:"?"wss":"ws";this.ws=new globalThis.WebSocket(`${e}://${globalThis.location.host}/ws`),this.ws.onopen=()=>{this.wsState="connected"},this.ws.onclose=()=>{this.wsState="reconnecting",this.retryTimer=setTimeout(()=>this.connect(),3e3)},this.ws.onerror=()=>{this.wsState="disconnected"},this.ws.onmessage=t=>{try{let a=JSON.parse(t.data);a.type==="inventory"&&(this.payload=a.data,this._forceOverride=a.data.forceOverride??null,this.selectedRequestId&&!this.requests.some(n=>n.requestId===this.selectedRequestId)&&(this.selectedRequestId=null,this.drawerOpen=!1))}catch{}}}get nodes(){return Object.values(this.payload.nodes||{})}get requests(){return this.payload.requests||[]}get summary(){return Fe(this.nodes)}get scanStatus(){let e=this.payload.scan||{};return e.lastScanAgo===-1?"Never scanned":`Scanned ${this._formatTime(e.lastScanAgo)} ago`}_formatTime(e){if(e<0)return"never";if(e<1e3)return"now";let t=Math.floor(e/1e3);if(t<60)return`${t}s`;let a=Math.floor(t/60);return a<60?`${a}m`:`${Math.floor(a/60)}h`}get selectedRequest(){let e=this.requests.find(t=>t.requestId===this.selectedRequestId);return e?e.hasMessages&&this.#t&&this.#t.requestId===e.requestId?{...e,...this.#t}:e:(this.#t=null,null)}#t=null;#e=null;openRequest(e){this.selectedRequestId=e,this.drawerOpen=!0,this.#a(0)}closeDrawer(){this.drawerOpen=!1,this.#e&&(clearInterval(this.#e),this.#e=null)}async#a(e=0){this.#e&&(clearInterval(this.#e),this.#e=null),await this.#s(),this.drawerOpen&&(this.#e=setInterval(()=>{this.drawerOpen&&this.#s()},2e3))}async#s(){let e=this.selectedRequestId;if(e)try{let t=await fetch(`/admin/requests/${encodeURIComponent(e)}`,{cache:"no-store"});if(!t.ok)return;let a=await t.json();if(a?.requestId!==e||e!==this.selectedRequestId)return;this.#t=a,this.requestUpdate()}catch{}}async onRescanClick(){if(!this.scanInProgress){this.scanInProgress=!0,this.rescanMessage="";try{let e=await fetch("/admin/discovery/scan-now",{method:"POST",headers:{"Content-Type":"application/json"}});if(!e.ok)throw new Error(`Scan failed: ${e.statusText}`);let t=await e.json();this.rescanMessage=`Scan complete: ${t.nodeCount} nodes found`,setTimeout(()=>{this.rescanMessage=""},3e3)}catch(e){this.rescanMessage=`Scan error: ${e.message}`,setTimeout(()=>{this.rescanMessage=""},5e3)}finally{this.scanInProgress=!1}}}async _clearForceOverride(){if(!this._clearingOverride){this._clearingOverride=!0;try{await fetch("/admin/force-model",{method:"DELETE"}),this._forceOverride=null}catch{}finally{this._clearingOverride=!1}}}handleRequestSelected(e){this.openRequest(e.detail.requestId)}_renderForceOverrideBanner(){if(!this._forceOverride)return"";let{model:e,expiresAt:t}=this._forceOverride,a=t-Date.now(),n=Math.floor(a/1e3/60),i=a<=0?"expired":n<1?"<1m":`~${n}m`;return r`
      <div class="force-override-banner">
        <span class="force-override-icon">▶</span>
        <span class="force-override-label">
          Next request forced to <strong>${e}</strong>
          <span class="force-override-ttl"> &mdash; expires in ${i}</span>
        </span>
        <button
          class="force-override-cancel"
          ?disabled=${this._clearingOverride}
          @click=${this._clearForceOverride}
          title="Cancel forced model override"
        >✕ Cancel</button>
      </div>
    `}render(){let e=this.summary,t=this.payload.cloudUsage??null;return r`
      <header>
        <div class="logo">
          <img
            class="logo-icon"
            src="/dashboard-assets/logo.svg"
            alt="Ollama Router"
            width="32"
            height="32"
          />
          <h1>Ollama Router <span>/ Dashboard</span></h1>
        </div>
        <div class="header-controls">
          <div class="scan-status">
            <span class="scan-text">${this.scanStatus}</span>
            <button
              class="rescan-btn ${this.scanInProgress?"scanning":""}"
              @click=${this.onRescanClick}
              ?disabled=${this.scanInProgress}
              title="Trigger immediate network scan"
            >
              <span class="rescan-icon" aria-hidden="true">↻</span>
              <span class="rescan-label"
                >${this.scanInProgress?"Scanning...":"Rescan"}</span
              >
            </button>
            ${this.rescanMessage?r`<span class="rescan-message">${this.rescanMessage}</span>`:""}
          </div>
          <div class="ws-status">
            <div class="dot ${this.wsState}"></div>
            <span>
              ${this.wsState==="connected"?"Live":this.wsState==="reconnecting"?"Reconnecting\u2026":this.wsState==="disconnected"?"Error":"Connecting\u2026"}
            </span>
          </div>
        </div>
      </header>

      <main>
        ${this._renderForceOverrideBanner()}

        <dashboard-summary .summary=${e}></dashboard-summary>

        <request-panel
          .requests=${this.requests}
          .selectedRequestId=${this.selectedRequestId}
          .drawerOpen=${this.drawerOpen}
          @request-selected=${this.handleRequestSelected}
        ></request-panel>

        <div class="nodes">
          ${this.nodes.length?this.nodes.map(a=>r`<node-card
                    .node=${a}
                    .forcedModel=${this._forceOverride?.model??null}
                    .cloudUsage=${a.cloud?t:null}
                  ></node-card>`):r`<div class="empty">No nodes configured.</div>`}
        </div>

        <div class="footer">
          Last update:
          ${this.payload.timestamp?new Date(this.payload.timestamp).toLocaleTimeString():"\u2014"}
        </div>
      </main>

      <unified-request-drawer
        .open=${this.drawerOpen}
        .request=${this.selectedRequest}
        @drawer-close=${this.closeDrawer}
      ></unified-request-drawer>
    `}};globalThis.customElements.define("router-dashboard",he);
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
