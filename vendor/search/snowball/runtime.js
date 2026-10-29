/*
 * Общее ядро Snowball (SnowballProgram, Among, SnowballStemmer)
 *
 * Сгенерированный Snowball-код (алгоритмы https://snowballstem.org/, BSD-3,
 * Copyright (c) 2001 Dr Martin Porter, (c) 2002 Richard Boulton), JS-порт
 * snowball-stemmers 0.6.0 (https://github.com/mazko/jssnowball, ISC, (c) Oleg Mazko).
 * Тексты лицензий — packages/search/LICENSE-snowball.
 * Файл вписан без изменений алгоритма: только обёртка в модуль и экспорты.
 * Не редактировать вручную; обновление — заменой кода целиком.
 */
// @ts-nocheck
/* eslint-disable */
var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };
function _possibleConstructorReturn(self, call) {
    if (!self) {
        throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
    }
    return call && ((typeof call === 'undefined' ? 'undefined' : _typeof(call)) === "object" || typeof call === "function") ? call : self;
}
function _inherits(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
        throw new TypeError("Super expression must either be null or a function, not " + (typeof superClass === 'undefined' ? 'undefined' : _typeof(superClass)));
    }
    subClass.prototype = Object.create(superClass && superClass.prototype, {
        constructor: {
            value: subClass,
            enumerable: false,
            writable: true,
            configurable: true
        }
    });
    if (superClass)
        Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass;
}
function _classCallCheck(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}
var _createClass = function () {
    function defineProperties(target, props) {
        for (var i = 0; i < props.length; i++) {
            var descriptor = props[i];
            descriptor.enumerable = descriptor.enumerable || false;
            descriptor.configurable = true;
            if ("value" in descriptor)
                descriptor.writable = true;
            Object.defineProperty(target, descriptor.key, descriptor);
        }
    }
    return function (Constructor, protoProps, staticProps) {
        if (protoProps)
            defineProperties(Constructor.prototype, protoProps);
        if (staticProps)
            defineProperties(Constructor, staticProps);
        return Constructor;
    };
}();
var _get = function get(object, property, receiver) {
    if (object === null)
        object = Function.prototype;
    var desc = Object.getOwnPropertyDescriptor(object, property);
    if (desc === undefined) {
        var parent = Object.getPrototypeOf(object);
        if (parent === null) {
            return undefined;
        }
        else {
            return get(parent, property, receiver);
        }
    }
    else if ("value" in desc) {
        return desc.value;
    }
    else {
        var getter = desc.get;
        if (getter === undefined) {
            return undefined;
        }
        return getter.call(receiver);
    }
};
var StringBuffer = function () {
    function StringBuffer() {
        _classCallCheck(this, StringBuffer);
    }
    _createClass(StringBuffer, [{
            key: 'length$esjava$0',
            value: function length$esjava$0() {
                return this.b.length;
            }
        }, {
            key: 'replace$esjava$3',
            value: function replace$esjava$3(start, end, str) {
                if (start === 0 && end === this.b.length) {
                    this.b = str;
                }
                else {
                    var left = this.b.substring(0, start), right = this.b.substring(end);
                    this.b = left + str + right;
                }
            }
        }, {
            key: 'substring$esjava$2',
            value: function substring$esjava$2(start, end) {
                return this.b.substring(start, end);
            }
        }, {
            key: 'charAt$esjava$1',
            value: function charAt$esjava$1(index) {
                return this.b.charCodeAt(index);
            }
        }, {
            key: 'subSequence$esjava$2',
            value: function subSequence$esjava$2(start, end) {
                throw new Error("NotImpl: CharSequence::subSequence");
            }
        }, {
            key: 'toString$esjava$0',
            value: function toString$esjava$0() {
                return this.b;
            }
        }, {
            key: 'length',
            value: function length() {
                var _get2;
                for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
                    args[_key] = arguments[_key];
                }
                switch (args.length) {
                    case 0:
                        return this.length$esjava$0.apply(this, args);
                }
                return (_get2 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'length', this)).call.apply(_get2, [this].concat(args));
            }
        }, {
            key: 'replace',
            value: function replace() {
                var _get3;
                for (var _len2 = arguments.length, args = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
                    args[_key2] = arguments[_key2];
                }
                switch (args.length) {
                    case 3:
                        return this.replace$esjava$3.apply(this, args);
                }
                return (_get3 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'replace', this)).call.apply(_get3, [this].concat(args));
            }
        }, {
            key: 'substring',
            value: function substring() {
                var _get4;
                for (var _len3 = arguments.length, args = Array(_len3), _key3 = 0; _key3 < _len3; _key3++) {
                    args[_key3] = arguments[_key3];
                }
                switch (args.length) {
                    case 2:
                        return this.substring$esjava$2.apply(this, args);
                }
                return (_get4 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'substring', this)).call.apply(_get4, [this].concat(args));
            }
        }, {
            key: 'charAt',
            value: function charAt() {
                var _get5;
                for (var _len4 = arguments.length, args = Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
                    args[_key4] = arguments[_key4];
                }
                switch (args.length) {
                    case 1:
                        return this.charAt$esjava$1.apply(this, args);
                }
                return (_get5 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'charAt', this)).call.apply(_get5, [this].concat(args));
            }
        }, {
            key: 'subSequence',
            value: function subSequence() {
                var _get6;
                for (var _len5 = arguments.length, args = Array(_len5), _key5 = 0; _key5 < _len5; _key5++) {
                    args[_key5] = arguments[_key5];
                }
                switch (args.length) {
                    case 2:
                        return this.subSequence$esjava$2.apply(this, args);
                }
                return (_get6 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'subSequence', this)).call.apply(_get6, [this].concat(args));
            }
        }, {
            key: 'toString',
            value: function toString() {
                var _get7;
                for (var _len6 = arguments.length, args = Array(_len6), _key6 = 0; _key6 < _len6; _key6++) {
                    args[_key6] = arguments[_key6];
                }
                switch (args.length) {
                    case 0:
                        return this.toString$esjava$0.apply(this, args);
                }
                return (_get7 = _get(Object.getPrototypeOf(StringBuffer.prototype), 'toString', this)).call.apply(_get7, [this].concat(args));
            }
        }, {
            key: 'b',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$b') ? this._$esjava$b : this._$esjava$b = "";
            },
            set: function set(v) {
                this._$esjava$b = v;
            }
        }]);
    return StringBuffer;
}();
var StringBuilder = function (_StringBuffer) {
    _inherits(StringBuilder, _StringBuffer);
    function StringBuilder() {
        _classCallCheck(this, StringBuilder);
        return _possibleConstructorReturn(this, Object.getPrototypeOf(StringBuilder).apply(this, arguments));
    }
    return StringBuilder;
}(StringBuffer);
var Among = function () {
    _createClass(Among, null, [{
            key: 'toCharArray$esjava$1',
            value: function toCharArray$esjava$1(s) {
                var sLength = s.length;
                var charArr = new Array(sLength);
                for (var i = 0; i < sLength; i++) {
                    charArr[i] = s.charCodeAt(i);
                }
                return charArr;
            }
        }]);
    function Among(s, substring_i, result, methodname, obj) {
        _classCallCheck(this, Among);
        this.s = Among.toCharArray$esjava$1(s);
        this.substring_i = substring_i;
        this.result = result;
        this.method = methodname ? obj[methodname] : null;
        this.methodobject = obj;
    }
    _createClass(Among, [{
            key: 's',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$s') ? this._$esjava$s : this._$esjava$s = null;
            },
            set: function set(v) {
                this._$esjava$s = v;
            }
        }, {
            key: 'substring_i',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$substring_i') ? this._$esjava$substring_i : this._$esjava$substring_i = 0;
            },
            set: function set(v) {
                this._$esjava$substring_i = v;
            }
        }, {
            key: 'result',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$result') ? this._$esjava$result : this._$esjava$result = 0;
            },
            set: function set(v) {
                this._$esjava$result = v;
            }
        }, {
            key: 'method',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$method') ? this._$esjava$method : this._$esjava$method = null;
            },
            set: function set(v) {
                this._$esjava$method = v;
            }
        }, {
            key: 'methodobject',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$methodobject') ? this._$esjava$methodobject : this._$esjava$methodobject = null;
            },
            set: function set(v) {
                this._$esjava$methodobject = v;
            }
        }]);
    return Among;
}();
var SnowballProgram = function () {
    function SnowballProgram() {
        _classCallCheck(this, SnowballProgram);
        this.current = new StringBuffer();
        this.setCurrent$esjava$1("");
    }
    _createClass(SnowballProgram, [{
            key: 'setCurrent$esjava$1',
            value: function setCurrent$esjava$1(value) {
                this.current.replace(0, this.current.length(), value);
                this.cursor = 0;
                this.limit = this.current.length();
                this.limit_backward = 0;
                this.bra = this.cursor;
                this.ket = this.limit;
            }
        }, {
            key: 'getCurrent$esjava$0',
            value: function getCurrent$esjava$0() {
                var result = this.current.toString();
                this.current = new StringBuffer();
                return result;
            }
        }, {
            key: 'in_grouping$esjava$3',
            value: function in_grouping$esjava$3(s, min, max) {
                if (this.cursor >= this.limit)
                    return false;
                var ch = this.current.charAt(this.cursor);
                if (ch > max || ch < min)
                    return false;
                ch -= min;
                if ((s[ch >> 3] & 0X1 << (ch & 0X7)) === 0)
                    return false;
                this.cursor++;
                return true;
            }
        }, {
            key: 'in_grouping_b$esjava$3',
            value: function in_grouping_b$esjava$3(s, min, max) {
                if (this.cursor <= this.limit_backward)
                    return false;
                var ch = this.current.charAt(this.cursor - 1);
                if (ch > max || ch < min)
                    return false;
                ch -= min;
                if ((s[ch >> 3] & 0X1 << (ch & 0X7)) === 0)
                    return false;
                this.cursor--;
                return true;
            }
        }, {
            key: 'out_grouping$esjava$3',
            value: function out_grouping$esjava$3(s, min, max) {
                if (this.cursor >= this.limit)
                    return false;
                var ch = this.current.charAt(this.cursor);
                if (ch > max || ch < min) {
                    this.cursor++;
                    return true;
                }
                ch -= min;
                if ((s[ch >> 3] & 0X1 << (ch & 0X7)) === 0) {
                    this.cursor++;
                    return true;
                }
                return false;
            }
        }, {
            key: 'out_grouping_b$esjava$3',
            value: function out_grouping_b$esjava$3(s, min, max) {
                if (this.cursor <= this.limit_backward)
                    return false;
                var ch = this.current.charAt(this.cursor - 1);
                if (ch > max || ch < min) {
                    this.cursor--;
                    return true;
                }
                ch -= min;
                if ((s[ch >> 3] & 0X1 << (ch & 0X7)) === 0) {
                    this.cursor--;
                    return true;
                }
                return false;
            }
        }, {
            key: 'eq_s$esjava$1',
            value: function eq_s$esjava$1(s) {
                if (this.limit - this.cursor < s.length)
                    return false;
                var i = undefined;
                for (i = 0; i !== s.length; i++) {
                    if (this.current.charAt(this.cursor + i) !== s.charCodeAt(i))
                        return false;
                }
                this.cursor += s.length;
                return true;
            }
        }, {
            key: 'eq_s_b$esjava$1',
            value: function eq_s_b$esjava$1(s) {
                if (this.cursor - this.limit_backward < s.length)
                    return false;
                var i = undefined;
                for (i = 0; i !== s.length; i++) {
                    if (this.current.charAt(this.cursor - s.length + i) !== s.charCodeAt(i))
                        return false;
                }
                this.cursor -= s.length;
                return true;
            }
        }, {
            key: 'find_among$esjava$1',
            value: function find_among$esjava$1(v) {
                var i = 0;
                var j = v.length;
                var c = this.cursor;
                var l = this.limit;
                var common_i = 0;
                var common_j = 0;
                var first_key_inspected = false;
                while (true) {
                    var k = i + (j - i >> 1);
                    var diff = 0;
                    var common = common_i < common_j ? common_i : common_j;
                    var w = v[k];
                    var i2 = undefined;
                    for (i2 = common; i2 < w.s.length; i2++) {
                        if (c + common === l) {
                            diff = -1;
                            break;
                        }
                        diff = this.current.charAt(c + common) - w.s[i2];
                        if (diff !== 0)
                            break;
                        common++;
                    }
                    if (diff < 0) {
                        j = k;
                        common_j = common;
                    }
                    else {
                        i = k;
                        common_i = common;
                    }
                    if (j - i <= 1) {
                        if (i > 0)
                            break;
                        if (j === i)
                            break;
                        if (first_key_inspected)
                            break;
                        first_key_inspected = true;
                    }
                }
                while (true) {
                    var w = v[i];
                    if (common_i >= w.s.length) {
                        this.cursor = c + w.s.length;
                        if (w.method === null)
                            return w.result;
                        var res = undefined;
                        res = w.method.call(w.methodobject);
                        this.cursor = c + w.s.length;
                        if (res)
                            return w.result;
                    }
                    i = w.substring_i;
                    if (i < 0)
                        return 0;
                }
            }
        }, {
            key: 'find_among_b$esjava$1',
            value: function find_among_b$esjava$1(v) {
                var i = 0;
                var j = v.length;
                var c = this.cursor;
                var lb = this.limit_backward;
                var common_i = 0;
                var common_j = 0;
                var first_key_inspected = false;
                while (true) {
                    var k = i + (j - i >> 1);
                    var diff = 0;
                    var common = common_i < common_j ? common_i : common_j;
                    var w = v[k];
                    var i2 = undefined;
                    for (i2 = w.s.length - 1 - common; i2 >= 0; i2--) {
                        if (c - common === lb) {
                            diff = -1;
                            break;
                        }
                        diff = this.current.charAt(c - 1 - common) - w.s[i2];
                        if (diff !== 0)
                            break;
                        common++;
                    }
                    if (diff < 0) {
                        j = k;
                        common_j = common;
                    }
                    else {
                        i = k;
                        common_i = common;
                    }
                    if (j - i <= 1) {
                        if (i > 0)
                            break;
                        if (j === i)
                            break;
                        if (first_key_inspected)
                            break;
                        first_key_inspected = true;
                    }
                }
                while (true) {
                    var w = v[i];
                    if (common_i >= w.s.length) {
                        this.cursor = c - w.s.length;
                        if (w.method === null)
                            return w.result;
                        var res = undefined;
                        res = w.method.call(w.methodobject);
                        this.cursor = c - w.s.length;
                        if (res)
                            return w.result;
                    }
                    i = w.substring_i;
                    if (i < 0)
                        return 0;
                }
            }
        }, {
            key: 'replace_s$esjava$3',
            value: function replace_s$esjava$3(c_bra, c_ket, s) {
                var adjustment = s.length - (c_ket - c_bra);
                this.current.replace(c_bra, c_ket, s);
                this.limit += adjustment;
                if (this.cursor >= c_ket)
                    this.cursor += adjustment;
                else if (this.cursor > c_bra)
                    this.cursor = c_bra;
                return adjustment;
            }
        }, {
            key: 'slice_check$esjava$0',
            value: function slice_check$esjava$0() {
                if (this.bra < 0 || this.bra > this.ket || this.ket > this.limit || this.limit > this.current.length()) {
                    throw new Error("Snowball: faulty slice operation");
                }
            }
        }, {
            key: 'slice_from$esjava$1',
            value: function slice_from$esjava$1(s) {
                this.slice_check$esjava$0();
                this.replace_s$esjava$3(this.bra, this.ket, s);
            }
        }, {
            key: 'slice_del$esjava$0',
            value: function slice_del$esjava$0() {
                this.slice_from$esjava$1("");
            }
        }, {
            key: 'insert$esjava$3',
            value: function insert$esjava$3(c_bra, c_ket, s) {
                var adjustment = this.replace_s$esjava$3(c_bra, c_ket, s);
                if (c_bra <= this.bra)
                    this.bra += adjustment;
                if (c_bra <= this.ket)
                    this.ket += adjustment;
            }
        }, {
            key: 'slice_to$esjava$1',
            value: function slice_to$esjava$1(s) {
                this.slice_check$esjava$0();
                s.replace(0, s.length(), this.current.substring(this.bra, this.ket));
                return s;
            }
        }, {
            key: 'setCurrent',
            value: function setCurrent() {
                var _get8;
                for (var _len7 = arguments.length, args = Array(_len7), _key7 = 0; _key7 < _len7; _key7++) {
                    args[_key7] = arguments[_key7];
                }
                switch (args.length) {
                    case 1:
                        return this.setCurrent$esjava$1.apply(this, args);
                }
                return (_get8 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'setCurrent', this)).call.apply(_get8, [this].concat(args));
            }
        }, {
            key: 'getCurrent',
            value: function getCurrent() {
                var _get9;
                for (var _len8 = arguments.length, args = Array(_len8), _key8 = 0; _key8 < _len8; _key8++) {
                    args[_key8] = arguments[_key8];
                }
                switch (args.length) {
                    case 0:
                        return this.getCurrent$esjava$0.apply(this, args);
                }
                return (_get9 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'getCurrent', this)).call.apply(_get9, [this].concat(args));
            }
        }, {
            key: 'in_grouping',
            value: function in_grouping() {
                var _get10;
                for (var _len9 = arguments.length, args = Array(_len9), _key9 = 0; _key9 < _len9; _key9++) {
                    args[_key9] = arguments[_key9];
                }
                switch (args.length) {
                    case 3:
                        return this.in_grouping$esjava$3.apply(this, args);
                }
                return (_get10 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'in_grouping', this)).call.apply(_get10, [this].concat(args));
            }
        }, {
            key: 'in_grouping_b',
            value: function in_grouping_b() {
                var _get11;
                for (var _len10 = arguments.length, args = Array(_len10), _key10 = 0; _key10 < _len10; _key10++) {
                    args[_key10] = arguments[_key10];
                }
                switch (args.length) {
                    case 3:
                        return this.in_grouping_b$esjava$3.apply(this, args);
                }
                return (_get11 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'in_grouping_b', this)).call.apply(_get11, [this].concat(args));
            }
        }, {
            key: 'out_grouping',
            value: function out_grouping() {
                var _get12;
                for (var _len11 = arguments.length, args = Array(_len11), _key11 = 0; _key11 < _len11; _key11++) {
                    args[_key11] = arguments[_key11];
                }
                switch (args.length) {
                    case 3:
                        return this.out_grouping$esjava$3.apply(this, args);
                }
                return (_get12 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'out_grouping', this)).call.apply(_get12, [this].concat(args));
            }
        }, {
            key: 'out_grouping_b',
            value: function out_grouping_b() {
                var _get13;
                for (var _len12 = arguments.length, args = Array(_len12), _key12 = 0; _key12 < _len12; _key12++) {
                    args[_key12] = arguments[_key12];
                }
                switch (args.length) {
                    case 3:
                        return this.out_grouping_b$esjava$3.apply(this, args);
                }
                return (_get13 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'out_grouping_b', this)).call.apply(_get13, [this].concat(args));
            }
        }, {
            key: 'eq_s',
            value: function eq_s() {
                var _get14;
                for (var _len13 = arguments.length, args = Array(_len13), _key13 = 0; _key13 < _len13; _key13++) {
                    args[_key13] = arguments[_key13];
                }
                switch (args.length) {
                    case 1:
                        return this.eq_s$esjava$1.apply(this, args);
                }
                return (_get14 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'eq_s', this)).call.apply(_get14, [this].concat(args));
            }
        }, {
            key: 'eq_s_b',
            value: function eq_s_b() {
                var _get15;
                for (var _len14 = arguments.length, args = Array(_len14), _key14 = 0; _key14 < _len14; _key14++) {
                    args[_key14] = arguments[_key14];
                }
                switch (args.length) {
                    case 1:
                        return this.eq_s_b$esjava$1.apply(this, args);
                }
                return (_get15 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'eq_s_b', this)).call.apply(_get15, [this].concat(args));
            }
        }, {
            key: 'find_among',
            value: function find_among() {
                var _get16;
                for (var _len15 = arguments.length, args = Array(_len15), _key15 = 0; _key15 < _len15; _key15++) {
                    args[_key15] = arguments[_key15];
                }
                switch (args.length) {
                    case 1:
                        return this.find_among$esjava$1.apply(this, args);
                }
                return (_get16 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'find_among', this)).call.apply(_get16, [this].concat(args));
            }
        }, {
            key: 'find_among_b',
            value: function find_among_b() {
                var _get17;
                for (var _len16 = arguments.length, args = Array(_len16), _key16 = 0; _key16 < _len16; _key16++) {
                    args[_key16] = arguments[_key16];
                }
                switch (args.length) {
                    case 1:
                        return this.find_among_b$esjava$1.apply(this, args);
                }
                return (_get17 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'find_among_b', this)).call.apply(_get17, [this].concat(args));
            }
        }, {
            key: 'replace_s',
            value: function replace_s() {
                var _get18;
                for (var _len17 = arguments.length, args = Array(_len17), _key17 = 0; _key17 < _len17; _key17++) {
                    args[_key17] = arguments[_key17];
                }
                switch (args.length) {
                    case 3:
                        return this.replace_s$esjava$3.apply(this, args);
                }
                return (_get18 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'replace_s', this)).call.apply(_get18, [this].concat(args));
            }
        }, {
            key: 'slice_check',
            value: function slice_check() {
                var _get19;
                for (var _len18 = arguments.length, args = Array(_len18), _key18 = 0; _key18 < _len18; _key18++) {
                    args[_key18] = arguments[_key18];
                }
                switch (args.length) {
                    case 0:
                        return this.slice_check$esjava$0.apply(this, args);
                }
                return (_get19 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'slice_check', this)).call.apply(_get19, [this].concat(args));
            }
        }, {
            key: 'slice_from',
            value: function slice_from() {
                var _get20;
                for (var _len19 = arguments.length, args = Array(_len19), _key19 = 0; _key19 < _len19; _key19++) {
                    args[_key19] = arguments[_key19];
                }
                switch (args.length) {
                    case 1:
                        return this.slice_from$esjava$1.apply(this, args);
                }
                return (_get20 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'slice_from', this)).call.apply(_get20, [this].concat(args));
            }
        }, {
            key: 'slice_del',
            value: function slice_del() {
                var _get21;
                for (var _len20 = arguments.length, args = Array(_len20), _key20 = 0; _key20 < _len20; _key20++) {
                    args[_key20] = arguments[_key20];
                }
                switch (args.length) {
                    case 0:
                        return this.slice_del$esjava$0.apply(this, args);
                }
                return (_get21 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'slice_del', this)).call.apply(_get21, [this].concat(args));
            }
        }, {
            key: 'insert',
            value: function insert() {
                var _get22;
                for (var _len21 = arguments.length, args = Array(_len21), _key21 = 0; _key21 < _len21; _key21++) {
                    args[_key21] = arguments[_key21];
                }
                switch (args.length) {
                    case 3:
                        return this.insert$esjava$3.apply(this, args);
                }
                return (_get22 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'insert', this)).call.apply(_get22, [this].concat(args));
            }
        }, {
            key: 'slice_to',
            value: function slice_to() {
                var _get23;
                for (var _len22 = arguments.length, args = Array(_len22), _key22 = 0; _key22 < _len22; _key22++) {
                    args[_key22] = arguments[_key22];
                }
                switch (args.length) {
                    case 1:
                        return this.slice_to$esjava$1.apply(this, args);
                }
                return (_get23 = _get(Object.getPrototypeOf(SnowballProgram.prototype), 'slice_to', this)).call.apply(_get23, [this].concat(args));
            }
        }, {
            key: 'current',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$current') ? this._$esjava$current : this._$esjava$current = null;
            },
            set: function set(v) {
                this._$esjava$current = v;
            }
        }, {
            key: 'cursor',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$cursor') ? this._$esjava$cursor : this._$esjava$cursor = 0;
            },
            set: function set(v) {
                this._$esjava$cursor = v;
            }
        }, {
            key: 'limit',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$limit') ? this._$esjava$limit : this._$esjava$limit = 0;
            },
            set: function set(v) {
                this._$esjava$limit = v;
            }
        }, {
            key: 'limit_backward',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$limit_backward') ? this._$esjava$limit_backward : this._$esjava$limit_backward = 0;
            },
            set: function set(v) {
                this._$esjava$limit_backward = v;
            }
        }, {
            key: 'bra',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$bra') ? this._$esjava$bra : this._$esjava$bra = 0;
            },
            set: function set(v) {
                this._$esjava$bra = v;
            }
        }, {
            key: 'ket',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$ket') ? this._$esjava$ket : this._$esjava$ket = 0;
            },
            set: function set(v) {
                this._$esjava$ket = v;
            }
        }]);
    return SnowballProgram;
}();
var SnowballStemmer = function (_SnowballProgram) {
    _inherits(SnowballStemmer, _SnowballProgram);
    function SnowballStemmer() {
        _classCallCheck(this, SnowballStemmer);
        return _possibleConstructorReturn(this, Object.getPrototypeOf(SnowballStemmer).apply(this, arguments));
    }
    _createClass(SnowballStemmer, [{
            key: 'stem$esjava$0',
            value: function stem$esjava$0() {
                throw 'NotImpl < stem$esjava$0 >';
            }
        }, {
            key: 'stem',
            value: function stem() {
                var _get24;
                for (var _len23 = arguments.length, args = Array(_len23), _key23 = 0; _key23 < _len23; _key23++) {
                    args[_key23] = arguments[_key23];
                }
                switch (args.length) {
                    case 0:
                        return this.stem$esjava$0.apply(this, args);
                }
                return (_get24 = _get(Object.getPrototypeOf(SnowballStemmer.prototype), 'stem', this)).call.apply(_get24, [this].concat(args));
            }
        }]);
    return SnowballStemmer;
}(SnowballProgram);
export { _typeof, _possibleConstructorReturn, _inherits, _classCallCheck, _createClass, _get, StringBuffer, StringBuilder, Among, SnowballProgram, SnowballStemmer };
//# sourceMappingURL=runtime.js.map