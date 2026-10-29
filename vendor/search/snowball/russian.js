/*
 * Snowball: русский стеммер
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
import { _possibleConstructorReturn, _inherits, _classCallCheck, _createClass, _get, Among, SnowballStemmer } from "./runtime.js";
var russianStemmer = function (_SnowballStemmer19) {
    _inherits(russianStemmer, _SnowballStemmer19);
    function russianStemmer() {
        _classCallCheck(this, russianStemmer);
        return _possibleConstructorReturn(this, Object.getPrototypeOf(russianStemmer).apply(this, arguments));
    }
    _createClass(russianStemmer, [{
            key: 'r_mark_regions$esjava$0',
            value: function r_mark_regions$esjava$0() {
                var v_1 = undefined;
                this.I_pV = this.limit;
                this.I_p2 = this.limit;
                v_1 = this.cursor;
                lab0: do {
                    golab1: while (true) {
                        lab2: do {
                            if (!this.in_grouping$esjava$3(russianStemmer.g_v, 1072, 1103)) {
                                break lab2;
                            }
                            break golab1;
                        } while (false);
                        if (this.cursor >= this.limit) {
                            break lab0;
                        }
                        this.cursor++;
                    }
                    this.I_pV = this.cursor;
                    golab3: while (true) {
                        lab4: do {
                            if (!this.out_grouping$esjava$3(russianStemmer.g_v, 1072, 1103)) {
                                break lab4;
                            }
                            break golab3;
                        } while (false);
                        if (this.cursor >= this.limit) {
                            break lab0;
                        }
                        this.cursor++;
                    }
                    golab5: while (true) {
                        lab6: do {
                            if (!this.in_grouping$esjava$3(russianStemmer.g_v, 1072, 1103)) {
                                break lab6;
                            }
                            break golab5;
                        } while (false);
                        if (this.cursor >= this.limit) {
                            break lab0;
                        }
                        this.cursor++;
                    }
                    golab7: while (true) {
                        lab8: do {
                            if (!this.out_grouping$esjava$3(russianStemmer.g_v, 1072, 1103)) {
                                break lab8;
                            }
                            break golab7;
                        } while (false);
                        if (this.cursor >= this.limit) {
                            break lab0;
                        }
                        this.cursor++;
                    }
                    this.I_p2 = this.cursor;
                } while (false);
                this.cursor = v_1;
                return true;
            }
        }, {
            key: 'r_R2$esjava$0',
            value: function r_R2$esjava$0() {
                if (!(this.I_p2 <= this.cursor)) {
                    return false;
                }
                return true;
            }
        }, {
            key: 'r_perfective_gerund$esjava$0',
            value: function r_perfective_gerund$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_0);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        lab0: do {
                            v_1 = this.limit - this.cursor;
                            lab1: do {
                                if (!this.eq_s_b$esjava$1('\u0430')) {
                                    break lab1;
                                }
                                break lab0;
                            } while (false);
                            this.cursor = this.limit - v_1;
                            if (!this.eq_s_b$esjava$1('\u044F')) {
                                return false;
                            }
                        } while (false);
                        this.slice_del$esjava$0();
                        break;
                    case 2:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_adjective$esjava$0',
            value: function r_adjective$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_1);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_adjectival$esjava$0',
            value: function r_adjectival$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                var v_2 = undefined;
                if (!this.r_adjective$esjava$0()) {
                    return false;
                }
                v_1 = this.limit - this.cursor;
                lab0: do {
                    this.ket = this.cursor;
                    among_var = this.find_among_b$esjava$1(russianStemmer.a_2);
                    if (among_var === 0) {
                        this.cursor = this.limit - v_1;
                        break lab0;
                    }
                    this.bra = this.cursor;
                    switch (among_var) {
                        case 0:
                            this.cursor = this.limit - v_1;
                            break lab0;
                        case 1:
                            lab1: do {
                                v_2 = this.limit - this.cursor;
                                lab2: do {
                                    if (!this.eq_s_b$esjava$1('\u0430')) {
                                        break lab2;
                                    }
                                    break lab1;
                                } while (false);
                                this.cursor = this.limit - v_2;
                                if (!this.eq_s_b$esjava$1('\u044F')) {
                                    this.cursor = this.limit - v_1;
                                    break lab0;
                                }
                            } while (false);
                            this.slice_del$esjava$0();
                            break;
                        case 2:
                            this.slice_del$esjava$0();
                            break;
                    }
                } while (false);
                return true;
            }
        }, {
            key: 'r_reflexive$esjava$0',
            value: function r_reflexive$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_3);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_verb$esjava$0',
            value: function r_verb$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_4);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        lab0: do {
                            v_1 = this.limit - this.cursor;
                            lab1: do {
                                if (!this.eq_s_b$esjava$1('\u0430')) {
                                    break lab1;
                                }
                                break lab0;
                            } while (false);
                            this.cursor = this.limit - v_1;
                            if (!this.eq_s_b$esjava$1('\u044F')) {
                                return false;
                            }
                        } while (false);
                        this.slice_del$esjava$0();
                        break;
                    case 2:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_noun$esjava$0',
            value: function r_noun$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_5);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_derivational$esjava$0',
            value: function r_derivational$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_6);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                if (!this.r_R2$esjava$0()) {
                    return false;
                }
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_tidy_up$esjava$0',
            value: function r_tidy_up$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(russianStemmer.a_7);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_del$esjava$0();
                        this.ket = this.cursor;
                        if (!this.eq_s_b$esjava$1('\u043D')) {
                            return false;
                        }
                        this.bra = this.cursor;
                        if (!this.eq_s_b$esjava$1('\u043D')) {
                            return false;
                        }
                        this.slice_del$esjava$0();
                        break;
                    case 2:
                        if (!this.eq_s_b$esjava$1('\u043D')) {
                            return false;
                        }
                        this.slice_del$esjava$0();
                        break;
                    case 3:
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'stem$esjava$0',
            value: function stem$esjava$0() {
                var v_1 = undefined;
                var v_2 = undefined;
                var v_3 = undefined;
                var v_4 = undefined;
                var v_5 = undefined;
                var v_6 = undefined;
                var v_7 = undefined;
                var v_8 = undefined;
                var v_9 = undefined;
                var v_10 = undefined;
                v_1 = this.cursor;
                lab0: do {
                    if (!this.r_mark_regions$esjava$0()) {
                        break lab0;
                    }
                } while (false);
                this.cursor = v_1;
                this.limit_backward = this.cursor;
                this.cursor = this.limit;
                v_2 = this.limit - this.cursor;
                if (this.cursor < this.I_pV) {
                    return false;
                }
                this.cursor = this.I_pV;
                v_3 = this.limit_backward;
                this.limit_backward = this.cursor;
                this.cursor = this.limit - v_2;
                v_4 = this.limit - this.cursor;
                lab1: do {
                    lab2: do {
                        v_5 = this.limit - this.cursor;
                        lab3: do {
                            if (!this.r_perfective_gerund$esjava$0()) {
                                break lab3;
                            }
                            break lab2;
                        } while (false);
                        this.cursor = this.limit - v_5;
                        v_6 = this.limit - this.cursor;
                        lab4: do {
                            if (!this.r_reflexive$esjava$0()) {
                                this.cursor = this.limit - v_6;
                                break lab4;
                            }
                        } while (false);
                        lab5: do {
                            v_7 = this.limit - this.cursor;
                            lab6: do {
                                if (!this.r_adjectival$esjava$0()) {
                                    break lab6;
                                }
                                break lab5;
                            } while (false);
                            this.cursor = this.limit - v_7;
                            lab7: do {
                                if (!this.r_verb$esjava$0()) {
                                    break lab7;
                                }
                                break lab5;
                            } while (false);
                            this.cursor = this.limit - v_7;
                            if (!this.r_noun$esjava$0()) {
                                break lab1;
                            }
                        } while (false);
                    } while (false);
                } while (false);
                this.cursor = this.limit - v_4;
                v_8 = this.limit - this.cursor;
                lab8: do {
                    this.ket = this.cursor;
                    if (!this.eq_s_b$esjava$1('\u0438')) {
                        this.cursor = this.limit - v_8;
                        break lab8;
                    }
                    this.bra = this.cursor;
                    this.slice_del$esjava$0();
                } while (false);
                v_9 = this.limit - this.cursor;
                lab9: do {
                    if (!this.r_derivational$esjava$0()) {
                        break lab9;
                    }
                } while (false);
                this.cursor = this.limit - v_9;
                v_10 = this.limit - this.cursor;
                lab10: do {
                    if (!this.r_tidy_up$esjava$0()) {
                        break lab10;
                    }
                } while (false);
                this.cursor = this.limit - v_10;
                this.limit_backward = v_3;
                this.cursor = this.limit_backward;
                return true;
            }
        }, {
            key: 'stem',
            value: function stem() {
                var _get45;
                for (var _len44 = arguments.length, args = Array(_len44), _key44 = 0; _key44 < _len44; _key44++) {
                    args[_key44] = arguments[_key44];
                }
                switch (args.length) {
                    case 0:
                        return this.stem$esjava$0.apply(this, args);
                }
                return (_get45 = _get(Object.getPrototypeOf(russianStemmer.prototype), 'stem', this)).call.apply(_get45, [this].concat(args));
            }
        }, {
            key: 'I_p2',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$I_p2') ? this._$esjava$I_p2 : this._$esjava$I_p2 = 0;
            },
            set: function set(v) {
                this._$esjava$I_p2 = v;
            }
        }, {
            key: 'I_pV',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$I_pV') ? this._$esjava$I_pV : this._$esjava$I_pV = 0;
            },
            set: function set(v) {
                this._$esjava$I_pV = v;
            }
        }], [{
            key: 'a_0',
            get: function get() {
                delete russianStemmer.a_0;
                return russianStemmer.a_0 = [new Among('\u0432', -1, 1), new Among('\u0438\u0432', 0, 2), new Among('\u044B\u0432', 0, 2), new Among('\u0432\u0448\u0438', -1, 1), new Among('\u0438\u0432\u0448\u0438', 3, 2), new Among('\u044B\u0432\u0448\u0438', 3, 2), new Among('\u0432\u0448\u0438\u0441\u044C', -1, 1), new Among('\u0438\u0432\u0448\u0438\u0441\u044C', 6, 2), new Among('\u044B\u0432\u0448\u0438\u0441\u044C', 6, 2)];
            }
        }, {
            key: 'a_1',
            get: function get() {
                delete russianStemmer.a_1;
                return russianStemmer.a_1 = [new Among('\u0435\u0435', -1, 1), new Among('\u0438\u0435', -1, 1), new Among('\u043E\u0435', -1, 1), new Among('\u044B\u0435', -1, 1), new Among('\u0438\u043C\u0438', -1, 1), new Among('\u044B\u043C\u0438', -1, 1), new Among('\u0435\u0439', -1, 1), new Among('\u0438\u0439', -1, 1), new Among('\u043E\u0439', -1, 1), new Among('\u044B\u0439', -1, 1), new Among('\u0435\u043C', -1, 1), new Among('\u0438\u043C', -1, 1), new Among('\u043E\u043C', -1, 1), new Among('\u044B\u043C', -1, 1), new Among('\u0435\u0433\u043E', -1, 1), new Among('\u043E\u0433\u043E', -1, 1), new Among('\u0435\u043C\u0443', -1, 1), new Among('\u043E\u043C\u0443', -1, 1), new Among('\u0438\u0445', -1, 1), new Among('\u044B\u0445', -1, 1), new Among('\u0435\u044E', -1, 1), new Among('\u043E\u044E', -1, 1), new Among('\u0443\u044E', -1, 1), new Among('\u044E\u044E', -1, 1), new Among('\u0430\u044F', -1, 1), new Among('\u044F\u044F', -1, 1)];
            }
        }, {
            key: 'a_2',
            get: function get() {
                delete russianStemmer.a_2;
                return russianStemmer.a_2 = [new Among('\u0435\u043C', -1, 1), new Among('\u043D\u043D', -1, 1), new Among('\u0432\u0448', -1, 1), new Among('\u0438\u0432\u0448', 2, 2), new Among('\u044B\u0432\u0448', 2, 2), new Among('\u0449', -1, 1), new Among('\u044E\u0449', 5, 1), new Among('\u0443\u044E\u0449', 6, 2)];
            }
        }, {
            key: 'a_3',
            get: function get() {
                delete russianStemmer.a_3;
                return russianStemmer.a_3 = [new Among('\u0441\u044C', -1, 1), new Among('\u0441\u044F', -1, 1)];
            }
        }, {
            key: 'a_4',
            get: function get() {
                delete russianStemmer.a_4;
                return russianStemmer.a_4 = [new Among('\u043B\u0430', -1, 1), new Among('\u0438\u043B\u0430', 0, 2), new Among('\u044B\u043B\u0430', 0, 2), new Among('\u043D\u0430', -1, 1), new Among('\u0435\u043D\u0430', 3, 2), new Among('\u0435\u0442\u0435', -1, 1), new Among('\u0438\u0442\u0435', -1, 2), new Among('\u0439\u0442\u0435', -1, 1), new Among('\u0435\u0439\u0442\u0435', 7, 2), new Among('\u0443\u0439\u0442\u0435', 7, 2), new Among('\u043B\u0438', -1, 1), new Among('\u0438\u043B\u0438', 10, 2), new Among('\u044B\u043B\u0438', 10, 2), new Among('\u0439', -1, 1), new Among('\u0435\u0439', 13, 2), new Among('\u0443\u0439', 13, 2), new Among('\u043B', -1, 1), new Among('\u0438\u043B', 16, 2), new Among('\u044B\u043B', 16, 2), new Among('\u0435\u043C', -1, 1), new Among('\u0438\u043C', -1, 2), new Among('\u044B\u043C', -1, 2), new Among('\u043D', -1, 1), new Among('\u0435\u043D', 22, 2), new Among('\u043B\u043E', -1, 1), new Among('\u0438\u043B\u043E', 24, 2), new Among('\u044B\u043B\u043E', 24, 2), new Among('\u043D\u043E', -1, 1), new Among('\u0435\u043D\u043E', 27, 2), new Among('\u043D\u043D\u043E', 27, 1), new Among('\u0435\u0442', -1, 1), new Among('\u0443\u0435\u0442', 30, 2), new Among('\u0438\u0442', -1, 2), new Among('\u044B\u0442', -1, 2), new Among('\u044E\u0442', -1, 1), new Among('\u0443\u044E\u0442', 34, 2), new Among('\u044F\u0442', -1, 2), new Among('\u043D\u044B', -1, 1), new Among('\u0435\u043D\u044B', 37, 2), new Among('\u0442\u044C', -1, 1), new Among('\u0438\u0442\u044C', 39, 2), new Among('\u044B\u0442\u044C', 39, 2), new Among('\u0435\u0448\u044C', -1, 1), new Among('\u0438\u0448\u044C', -1, 2), new Among('\u044E', -1, 2), new Among('\u0443\u044E', 44, 2)];
            }
        }, {
            key: 'a_5',
            get: function get() {
                delete russianStemmer.a_5;
                return russianStemmer.a_5 = [new Among('\u0430', -1, 1), new Among('\u0435\u0432', -1, 1), new Among('\u043E\u0432', -1, 1), new Among('\u0435', -1, 1), new Among('\u0438\u0435', 3, 1), new Among('\u044C\u0435', 3, 1), new Among('\u0438', -1, 1), new Among('\u0435\u0438', 6, 1), new Among('\u0438\u0438', 6, 1), new Among('\u0430\u043C\u0438', 6, 1), new Among('\u044F\u043C\u0438', 6, 1), new Among('\u0438\u044F\u043C\u0438', 10, 1), new Among('\u0439', -1, 1), new Among('\u0435\u0439', 12, 1), new Among('\u0438\u0435\u0439', 13, 1), new Among('\u0438\u0439', 12, 1), new Among('\u043E\u0439', 12, 1), new Among('\u0430\u043C', -1, 1), new Among('\u0435\u043C', -1, 1), new Among('\u0438\u0435\u043C', 18, 1), new Among('\u043E\u043C', -1, 1), new Among('\u044F\u043C', -1, 1), new Among('\u0438\u044F\u043C', 21, 1), new Among('\u043E', -1, 1), new Among('\u0443', -1, 1), new Among('\u0430\u0445', -1, 1), new Among('\u044F\u0445', -1, 1), new Among('\u0438\u044F\u0445', 26, 1), new Among('\u044B', -1, 1), new Among('\u044C', -1, 1), new Among('\u044E', -1, 1), new Among('\u0438\u044E', 30, 1), new Among('\u044C\u044E', 30, 1), new Among('\u044F', -1, 1), new Among('\u0438\u044F', 33, 1), new Among('\u044C\u044F', 33, 1)];
            }
        }, {
            key: 'a_6',
            get: function get() {
                delete russianStemmer.a_6;
                return russianStemmer.a_6 = [new Among('\u043E\u0441\u0442', -1, 1), new Among('\u043E\u0441\u0442\u044C', -1, 1)];
            }
        }, {
            key: 'a_7',
            get: function get() {
                delete russianStemmer.a_7;
                return russianStemmer.a_7 = [new Among('\u0435\u0439\u0448\u0435', -1, 1), new Among('\u043D', -1, 2), new Among('\u0435\u0439\u0448', -1, 1), new Among('\u044C', -1, 3)];
            }
        }, {
            key: 'g_v',
            get: function get() {
                delete russianStemmer.g_v;
                return russianStemmer.g_v = [33, 65, 8, 232];
            }
        }]);
    return russianStemmer;
}(SnowballStemmer);
const stemmer = new russianStemmer();
export function stemRu(word) {
    stemmer.setCurrent(word);
    stemmer.stem();
    return stemmer.getCurrent();
}
//# sourceMappingURL=russian.js.map