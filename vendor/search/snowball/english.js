/*
 * Snowball: английский стеммер
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
var englishStemmer = function (_SnowballStemmer8) {
    _inherits(englishStemmer, _SnowballStemmer8);
    function englishStemmer() {
        _classCallCheck(this, englishStemmer);
        return _possibleConstructorReturn(this, Object.getPrototypeOf(englishStemmer).apply(this, arguments));
    }
    _createClass(englishStemmer, [{
            key: 'r_prelude$esjava$0',
            value: function r_prelude$esjava$0() {
                var v_1 = undefined;
                var v_2 = undefined;
                var v_3 = undefined;
                var v_4 = undefined;
                var v_5 = undefined;
                this.B_Y_found = false;
                v_1 = this.cursor;
                lab0: do {
                    this.bra = this.cursor;
                    if (!this.eq_s$esjava$1("'")) {
                        break lab0;
                    }
                    this.ket = this.cursor;
                    this.slice_del$esjava$0();
                } while (false);
                this.cursor = v_1;
                v_2 = this.cursor;
                lab1: do {
                    this.bra = this.cursor;
                    if (!this.eq_s$esjava$1("y")) {
                        break lab1;
                    }
                    this.ket = this.cursor;
                    this.slice_from$esjava$1("Y");
                    this.B_Y_found = true;
                } while (false);
                this.cursor = v_2;
                v_3 = this.cursor;
                lab2: do {
                    replab3: while (true) {
                        v_4 = this.cursor;
                        lab4: do {
                            golab5: while (true) {
                                v_5 = this.cursor;
                                lab6: do {
                                    if (!this.in_grouping$esjava$3(englishStemmer.g_v, 97, 121)) {
                                        break lab6;
                                    }
                                    this.bra = this.cursor;
                                    if (!this.eq_s$esjava$1("y")) {
                                        break lab6;
                                    }
                                    this.ket = this.cursor;
                                    this.cursor = v_5;
                                    break golab5;
                                } while (false);
                                this.cursor = v_5;
                                if (this.cursor >= this.limit) {
                                    break lab4;
                                }
                                this.cursor++;
                            }
                            this.slice_from$esjava$1("Y");
                            this.B_Y_found = true;
                            continue replab3;
                        } while (false);
                        this.cursor = v_4;
                        break replab3;
                    }
                } while (false);
                this.cursor = v_3;
                return true;
            }
        }, {
            key: 'r_mark_regions$esjava$0',
            value: function r_mark_regions$esjava$0() {
                var v_1 = undefined;
                var v_2 = undefined;
                this.I_p1 = this.limit;
                this.I_p2 = this.limit;
                v_1 = this.cursor;
                lab0: do {
                    lab1: do {
                        v_2 = this.cursor;
                        lab2: do {
                            if (this.find_among$esjava$1(englishStemmer.a_0) === 0) {
                                break lab2;
                            }
                            break lab1;
                        } while (false);
                        this.cursor = v_2;
                        golab3: while (true) {
                            lab4: do {
                                if (!this.in_grouping$esjava$3(englishStemmer.g_v, 97, 121)) {
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
                                if (!this.out_grouping$esjava$3(englishStemmer.g_v, 97, 121)) {
                                    break lab6;
                                }
                                break golab5;
                            } while (false);
                            if (this.cursor >= this.limit) {
                                break lab0;
                            }
                            this.cursor++;
                        }
                    } while (false);
                    this.I_p1 = this.cursor;
                    golab7: while (true) {
                        lab8: do {
                            if (!this.in_grouping$esjava$3(englishStemmer.g_v, 97, 121)) {
                                break lab8;
                            }
                            break golab7;
                        } while (false);
                        if (this.cursor >= this.limit) {
                            break lab0;
                        }
                        this.cursor++;
                    }
                    golab9: while (true) {
                        lab10: do {
                            if (!this.out_grouping$esjava$3(englishStemmer.g_v, 97, 121)) {
                                break lab10;
                            }
                            break golab9;
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
            key: 'r_shortv$esjava$0',
            value: function r_shortv$esjava$0() {
                var v_1 = undefined;
                lab0: do {
                    v_1 = this.limit - this.cursor;
                    lab1: do {
                        if (!this.out_grouping_b$esjava$3(englishStemmer.g_v_WXY, 89, 121)) {
                            break lab1;
                        }
                        if (!this.in_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                            break lab1;
                        }
                        if (!this.out_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                            break lab1;
                        }
                        break lab0;
                    } while (false);
                    this.cursor = this.limit - v_1;
                    if (!this.out_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                        return false;
                    }
                    if (!this.in_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                        return false;
                    }
                    if (this.cursor > this.limit_backward) {
                        return false;
                    }
                } while (false);
                return true;
            }
        }, {
            key: 'r_R1$esjava$0',
            value: function r_R1$esjava$0() {
                if (!(this.I_p1 <= this.cursor)) {
                    return false;
                }
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
            key: 'r_Step_1a$esjava$0',
            value: function r_Step_1a$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                var v_2 = undefined;
                v_1 = this.limit - this.cursor;
                lab0: do {
                    this.ket = this.cursor;
                    among_var = this.find_among_b$esjava$1(englishStemmer.a_1);
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
                            this.slice_del$esjava$0();
                            break;
                    }
                } while (false);
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_2);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_from$esjava$1("ss");
                        break;
                    case 2:
                        lab1: do {
                            v_2 = this.limit - this.cursor;
                            lab2: do {
                                {
                                    var c = this.cursor - 2;
                                    if (this.limit_backward > c || c > this.limit) {
                                        break lab2;
                                    }
                                    this.cursor = c;
                                }
                                this.slice_from$esjava$1("i");
                                break lab1;
                            } while (false);
                            this.cursor = this.limit - v_2;
                            this.slice_from$esjava$1("ie");
                        } while (false);
                        break;
                    case 3:
                        if (this.cursor <= this.limit_backward) {
                            return false;
                        }
                        this.cursor--;
                        golab3: while (true) {
                            lab4: do {
                                if (!this.in_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                                    break lab4;
                                }
                                break golab3;
                            } while (false);
                            if (this.cursor <= this.limit_backward) {
                                return false;
                            }
                            this.cursor--;
                        }
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_Step_1b$esjava$0',
            value: function r_Step_1b$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                var v_3 = undefined;
                var v_4 = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_4);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        if (!this.r_R1$esjava$0()) {
                            return false;
                        }
                        this.slice_from$esjava$1("ee");
                        break;
                    case 2:
                        v_1 = this.limit - this.cursor;
                        golab0: while (true) {
                            lab1: do {
                                if (!this.in_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                                    break lab1;
                                }
                                break golab0;
                            } while (false);
                            if (this.cursor <= this.limit_backward) {
                                return false;
                            }
                            this.cursor--;
                        }
                        this.cursor = this.limit - v_1;
                        this.slice_del$esjava$0();
                        v_3 = this.limit - this.cursor;
                        among_var = this.find_among_b$esjava$1(englishStemmer.a_3);
                        if (among_var === 0) {
                            return false;
                        }
                        this.cursor = this.limit - v_3;
                        switch (among_var) {
                            case 0:
                                return false;
                            case 1:
                                {
                                    var c = this.cursor;
                                    this.insert$esjava$3(this.cursor, this.cursor, "e");
                                    this.cursor = c;
                                }
                                break;
                            case 2:
                                this.ket = this.cursor;
                                if (this.cursor <= this.limit_backward) {
                                    return false;
                                }
                                this.cursor--;
                                this.bra = this.cursor;
                                this.slice_del$esjava$0();
                                break;
                            case 3:
                                if (this.cursor !== this.I_p1) {
                                    return false;
                                }
                                v_4 = this.limit - this.cursor;
                                if (!this.r_shortv$esjava$0()) {
                                    return false;
                                }
                                this.cursor = this.limit - v_4;
                                {
                                    var c = this.cursor;
                                    this.insert$esjava$3(this.cursor, this.cursor, "e");
                                    this.cursor = c;
                                }
                                break;
                        }
                        break;
                }
                return true;
            }
        }, {
            key: 'r_Step_1c$esjava$0',
            value: function r_Step_1c$esjava$0() {
                var v_1 = undefined;
                var v_2 = undefined;
                this.ket = this.cursor;
                lab0: do {
                    v_1 = this.limit - this.cursor;
                    lab1: do {
                        if (!this.eq_s_b$esjava$1("y")) {
                            break lab1;
                        }
                        break lab0;
                    } while (false);
                    this.cursor = this.limit - v_1;
                    if (!this.eq_s_b$esjava$1("Y")) {
                        return false;
                    }
                } while (false);
                this.bra = this.cursor;
                if (!this.out_grouping_b$esjava$3(englishStemmer.g_v, 97, 121)) {
                    return false;
                }
                {
                    v_2 = this.limit - this.cursor;
                    lab2: do {
                        if (this.cursor > this.limit_backward) {
                            break lab2;
                        }
                        return false;
                    } while (false);
                    this.cursor = this.limit - v_2;
                }
                this.slice_from$esjava$1("i");
                return true;
            }
        }, {
            key: 'r_Step_2$esjava$0',
            value: function r_Step_2$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_5);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                if (!this.r_R1$esjava$0()) {
                    return false;
                }
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_from$esjava$1("tion");
                        break;
                    case 2:
                        this.slice_from$esjava$1("ence");
                        break;
                    case 3:
                        this.slice_from$esjava$1("ance");
                        break;
                    case 4:
                        this.slice_from$esjava$1("able");
                        break;
                    case 5:
                        this.slice_from$esjava$1("ent");
                        break;
                    case 6:
                        this.slice_from$esjava$1("ize");
                        break;
                    case 7:
                        this.slice_from$esjava$1("ate");
                        break;
                    case 8:
                        this.slice_from$esjava$1("al");
                        break;
                    case 9:
                        this.slice_from$esjava$1("ful");
                        break;
                    case 10:
                        this.slice_from$esjava$1("ous");
                        break;
                    case 11:
                        this.slice_from$esjava$1("ive");
                        break;
                    case 12:
                        this.slice_from$esjava$1("ble");
                        break;
                    case 13:
                        if (!this.eq_s_b$esjava$1("l")) {
                            return false;
                        }
                        this.slice_from$esjava$1("og");
                        break;
                    case 14:
                        this.slice_from$esjava$1("ful");
                        break;
                    case 15:
                        this.slice_from$esjava$1("less");
                        break;
                    case 16:
                        if (!this.in_grouping_b$esjava$3(englishStemmer.g_valid_LI, 99, 116)) {
                            return false;
                        }
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_Step_3$esjava$0',
            value: function r_Step_3$esjava$0() {
                var among_var = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_6);
                if (among_var === 0) {
                    return false;
                }
                this.bra = this.cursor;
                if (!this.r_R1$esjava$0()) {
                    return false;
                }
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_from$esjava$1("tion");
                        break;
                    case 2:
                        this.slice_from$esjava$1("ate");
                        break;
                    case 3:
                        this.slice_from$esjava$1("al");
                        break;
                    case 4:
                        this.slice_from$esjava$1("ic");
                        break;
                    case 5:
                        this.slice_del$esjava$0();
                        break;
                    case 6:
                        if (!this.r_R2$esjava$0()) {
                            return false;
                        }
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_Step_4$esjava$0',
            value: function r_Step_4$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_7);
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
                    case 2:
                        lab0: do {
                            v_1 = this.limit - this.cursor;
                            lab1: do {
                                if (!this.eq_s_b$esjava$1("s")) {
                                    break lab1;
                                }
                                break lab0;
                            } while (false);
                            this.cursor = this.limit - v_1;
                            if (!this.eq_s_b$esjava$1("t")) {
                                return false;
                            }
                        } while (false);
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_Step_5$esjava$0',
            value: function r_Step_5$esjava$0() {
                var among_var = undefined;
                var v_1 = undefined;
                var v_2 = undefined;
                this.ket = this.cursor;
                among_var = this.find_among_b$esjava$1(englishStemmer.a_8);
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
                                if (!this.r_R2$esjava$0()) {
                                    break lab1;
                                }
                                break lab0;
                            } while (false);
                            this.cursor = this.limit - v_1;
                            if (!this.r_R1$esjava$0()) {
                                return false;
                            }
                            {
                                v_2 = this.limit - this.cursor;
                                lab2: do {
                                    if (!this.r_shortv$esjava$0()) {
                                        break lab2;
                                    }
                                    return false;
                                } while (false);
                                this.cursor = this.limit - v_2;
                            }
                        } while (false);
                        this.slice_del$esjava$0();
                        break;
                    case 2:
                        if (!this.r_R2$esjava$0()) {
                            return false;
                        }
                        if (!this.eq_s_b$esjava$1("l")) {
                            return false;
                        }
                        this.slice_del$esjava$0();
                        break;
                }
                return true;
            }
        }, {
            key: 'r_exception2$esjava$0',
            value: function r_exception2$esjava$0() {
                this.ket = this.cursor;
                if (this.find_among_b$esjava$1(englishStemmer.a_9) === 0) {
                    return false;
                }
                this.bra = this.cursor;
                if (this.cursor > this.limit_backward) {
                    return false;
                }
                return true;
            }
        }, {
            key: 'r_exception1$esjava$0',
            value: function r_exception1$esjava$0() {
                var among_var = undefined;
                this.bra = this.cursor;
                among_var = this.find_among$esjava$1(englishStemmer.a_10);
                if (among_var === 0) {
                    return false;
                }
                this.ket = this.cursor;
                if (this.cursor < this.limit) {
                    return false;
                }
                switch (among_var) {
                    case 0:
                        return false;
                    case 1:
                        this.slice_from$esjava$1("ski");
                        break;
                    case 2:
                        this.slice_from$esjava$1("sky");
                        break;
                    case 3:
                        this.slice_from$esjava$1("die");
                        break;
                    case 4:
                        this.slice_from$esjava$1("lie");
                        break;
                    case 5:
                        this.slice_from$esjava$1("tie");
                        break;
                    case 6:
                        this.slice_from$esjava$1("idl");
                        break;
                    case 7:
                        this.slice_from$esjava$1("gentl");
                        break;
                    case 8:
                        this.slice_from$esjava$1("ugli");
                        break;
                    case 9:
                        this.slice_from$esjava$1("earli");
                        break;
                    case 10:
                        this.slice_from$esjava$1("onli");
                        break;
                    case 11:
                        this.slice_from$esjava$1("singl");
                        break;
                }
                return true;
            }
        }, {
            key: 'r_postlude$esjava$0',
            value: function r_postlude$esjava$0() {
                var v_1 = undefined;
                var v_2 = undefined;
                if (!this.B_Y_found) {
                    return false;
                }
                replab0: while (true) {
                    v_1 = this.cursor;
                    lab1: do {
                        golab2: while (true) {
                            v_2 = this.cursor;
                            lab3: do {
                                this.bra = this.cursor;
                                if (!this.eq_s$esjava$1("Y")) {
                                    break lab3;
                                }
                                this.ket = this.cursor;
                                this.cursor = v_2;
                                break golab2;
                            } while (false);
                            this.cursor = v_2;
                            if (this.cursor >= this.limit) {
                                break lab1;
                            }
                            this.cursor++;
                        }
                        this.slice_from$esjava$1("y");
                        continue replab0;
                    } while (false);
                    this.cursor = v_1;
                    break replab0;
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
                var v_11 = undefined;
                var v_12 = undefined;
                var v_13 = undefined;
                lab0: do {
                    v_1 = this.cursor;
                    lab1: do {
                        if (!this.r_exception1$esjava$0()) {
                            break lab1;
                        }
                        break lab0;
                    } while (false);
                    this.cursor = v_1;
                    lab2: do {
                        {
                            v_2 = this.cursor;
                            lab3: do {
                                {
                                    var c = this.cursor + 3;
                                    if (0 > c || c > this.limit) {
                                        break lab3;
                                    }
                                    this.cursor = c;
                                }
                                break lab2;
                            } while (false);
                            this.cursor = v_2;
                        }
                        break lab0;
                    } while (false);
                    this.cursor = v_1;
                    v_3 = this.cursor;
                    lab4: do {
                        if (!this.r_prelude$esjava$0()) {
                            break lab4;
                        }
                    } while (false);
                    this.cursor = v_3;
                    v_4 = this.cursor;
                    lab5: do {
                        if (!this.r_mark_regions$esjava$0()) {
                            break lab5;
                        }
                    } while (false);
                    this.cursor = v_4;
                    this.limit_backward = this.cursor;
                    this.cursor = this.limit;
                    v_5 = this.limit - this.cursor;
                    lab6: do {
                        if (!this.r_Step_1a$esjava$0()) {
                            break lab6;
                        }
                    } while (false);
                    this.cursor = this.limit - v_5;
                    lab7: do {
                        v_6 = this.limit - this.cursor;
                        lab8: do {
                            if (!this.r_exception2$esjava$0()) {
                                break lab8;
                            }
                            break lab7;
                        } while (false);
                        this.cursor = this.limit - v_6;
                        v_7 = this.limit - this.cursor;
                        lab9: do {
                            if (!this.r_Step_1b$esjava$0()) {
                                break lab9;
                            }
                        } while (false);
                        this.cursor = this.limit - v_7;
                        v_8 = this.limit - this.cursor;
                        lab10: do {
                            if (!this.r_Step_1c$esjava$0()) {
                                break lab10;
                            }
                        } while (false);
                        this.cursor = this.limit - v_8;
                        v_9 = this.limit - this.cursor;
                        lab11: do {
                            if (!this.r_Step_2$esjava$0()) {
                                break lab11;
                            }
                        } while (false);
                        this.cursor = this.limit - v_9;
                        v_10 = this.limit - this.cursor;
                        lab12: do {
                            if (!this.r_Step_3$esjava$0()) {
                                break lab12;
                            }
                        } while (false);
                        this.cursor = this.limit - v_10;
                        v_11 = this.limit - this.cursor;
                        lab13: do {
                            if (!this.r_Step_4$esjava$0()) {
                                break lab13;
                            }
                        } while (false);
                        this.cursor = this.limit - v_11;
                        v_12 = this.limit - this.cursor;
                        lab14: do {
                            if (!this.r_Step_5$esjava$0()) {
                                break lab14;
                            }
                        } while (false);
                        this.cursor = this.limit - v_12;
                    } while (false);
                    this.cursor = this.limit_backward;
                    v_13 = this.cursor;
                    lab15: do {
                        if (!this.r_postlude$esjava$0()) {
                            break lab15;
                        }
                    } while (false);
                    this.cursor = v_13;
                } while (false);
                return true;
            }
        }, {
            key: 'stem',
            value: function stem() {
                var _get32;
                for (var _len31 = arguments.length, args = Array(_len31), _key31 = 0; _key31 < _len31; _key31++) {
                    args[_key31] = arguments[_key31];
                }
                switch (args.length) {
                    case 0:
                        return this.stem$esjava$0.apply(this, args);
                }
                return (_get32 = _get(Object.getPrototypeOf(englishStemmer.prototype), 'stem', this)).call.apply(_get32, [this].concat(args));
            }
        }, {
            key: 'B_Y_found',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$B_Y_found') ? this._$esjava$B_Y_found : this._$esjava$B_Y_found = false;
            },
            set: function set(v) {
                this._$esjava$B_Y_found = v;
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
            key: 'I_p1',
            get: function get() {
                return Object.prototype.hasOwnProperty.call(this, '_$esjava$I_p1') ? this._$esjava$I_p1 : this._$esjava$I_p1 = 0;
            },
            set: function set(v) {
                this._$esjava$I_p1 = v;
            }
        }], [{
            key: 'a_0',
            get: function get() {
                delete englishStemmer.a_0;
                return englishStemmer.a_0 = [new Among("arsen", -1, -1), new Among("commun", -1, -1), new Among("gener", -1, -1)];
            }
        }, {
            key: 'a_1',
            get: function get() {
                delete englishStemmer.a_1;
                return englishStemmer.a_1 = [new Among("'", -1, 1), new Among("'s'", 0, 1), new Among("'s", -1, 1)];
            }
        }, {
            key: 'a_2',
            get: function get() {
                delete englishStemmer.a_2;
                return englishStemmer.a_2 = [new Among("ied", -1, 2), new Among("s", -1, 3), new Among("ies", 1, 2), new Among("sses", 1, 1), new Among("ss", 1, -1), new Among("us", 1, -1)];
            }
        }, {
            key: 'a_3',
            get: function get() {
                delete englishStemmer.a_3;
                return englishStemmer.a_3 = [new Among("", -1, 3), new Among("bb", 0, 2), new Among("dd", 0, 2), new Among("ff", 0, 2), new Among("gg", 0, 2), new Among("bl", 0, 1), new Among("mm", 0, 2), new Among("nn", 0, 2), new Among("pp", 0, 2), new Among("rr", 0, 2), new Among("at", 0, 1), new Among("tt", 0, 2), new Among("iz", 0, 1)];
            }
        }, {
            key: 'a_4',
            get: function get() {
                delete englishStemmer.a_4;
                return englishStemmer.a_4 = [new Among("ed", -1, 2), new Among("eed", 0, 1), new Among("ing", -1, 2), new Among("edly", -1, 2), new Among("eedly", 3, 1), new Among("ingly", -1, 2)];
            }
        }, {
            key: 'a_5',
            get: function get() {
                delete englishStemmer.a_5;
                return englishStemmer.a_5 = [new Among("anci", -1, 3), new Among("enci", -1, 2), new Among("ogi", -1, 13), new Among("li", -1, 16), new Among("bli", 3, 12), new Among("abli", 4, 4), new Among("alli", 3, 8), new Among("fulli", 3, 14), new Among("lessli", 3, 15), new Among("ousli", 3, 10), new Among("entli", 3, 5), new Among("aliti", -1, 8), new Among("biliti", -1, 12), new Among("iviti", -1, 11), new Among("tional", -1, 1), new Among("ational", 14, 7), new Among("alism", -1, 8), new Among("ation", -1, 7), new Among("ization", 17, 6), new Among("izer", -1, 6), new Among("ator", -1, 7), new Among("iveness", -1, 11), new Among("fulness", -1, 9), new Among("ousness", -1, 10)];
            }
        }, {
            key: 'a_6',
            get: function get() {
                delete englishStemmer.a_6;
                return englishStemmer.a_6 = [new Among("icate", -1, 4), new Among("ative", -1, 6), new Among("alize", -1, 3), new Among("iciti", -1, 4), new Among("ical", -1, 4), new Among("tional", -1, 1), new Among("ational", 5, 2), new Among("ful", -1, 5), new Among("ness", -1, 5)];
            }
        }, {
            key: 'a_7',
            get: function get() {
                delete englishStemmer.a_7;
                return englishStemmer.a_7 = [new Among("ic", -1, 1), new Among("ance", -1, 1), new Among("ence", -1, 1), new Among("able", -1, 1), new Among("ible", -1, 1), new Among("ate", -1, 1), new Among("ive", -1, 1), new Among("ize", -1, 1), new Among("iti", -1, 1), new Among("al", -1, 1), new Among("ism", -1, 1), new Among("ion", -1, 2), new Among("er", -1, 1), new Among("ous", -1, 1), new Among("ant", -1, 1), new Among("ent", -1, 1), new Among("ment", 15, 1), new Among("ement", 16, 1)];
            }
        }, {
            key: 'a_8',
            get: function get() {
                delete englishStemmer.a_8;
                return englishStemmer.a_8 = [new Among("e", -1, 1), new Among("l", -1, 2)];
            }
        }, {
            key: 'a_9',
            get: function get() {
                delete englishStemmer.a_9;
                return englishStemmer.a_9 = [new Among("succeed", -1, -1), new Among("proceed", -1, -1), new Among("exceed", -1, -1), new Among("canning", -1, -1), new Among("inning", -1, -1), new Among("earring", -1, -1), new Among("herring", -1, -1), new Among("outing", -1, -1)];
            }
        }, {
            key: 'a_10',
            get: function get() {
                delete englishStemmer.a_10;
                return englishStemmer.a_10 = [new Among("andes", -1, -1), new Among("atlas", -1, -1), new Among("bias", -1, -1), new Among("cosmos", -1, -1), new Among("dying", -1, 3), new Among("early", -1, 9), new Among("gently", -1, 7), new Among("howe", -1, -1), new Among("idly", -1, 6), new Among("lying", -1, 4), new Among("news", -1, -1), new Among("only", -1, 10), new Among("singly", -1, 11), new Among("skies", -1, 2), new Among("skis", -1, 1), new Among("sky", -1, -1), new Among("tying", -1, 5), new Among("ugly", -1, 8)];
            }
        }, {
            key: 'g_v',
            get: function get() {
                delete englishStemmer.g_v;
                return englishStemmer.g_v = [17, 65, 16, 1];
            }
        }, {
            key: 'g_v_WXY',
            get: function get() {
                delete englishStemmer.g_v_WXY;
                return englishStemmer.g_v_WXY = [1, 17, 65, 208, 1];
            }
        }, {
            key: 'g_valid_LI',
            get: function get() {
                delete englishStemmer.g_valid_LI;
                return englishStemmer.g_valid_LI = [55, 141, 2];
            }
        }]);
    return englishStemmer;
}(SnowballStemmer);
const stemmer = new englishStemmer();
export function stemEn(word) {
    stemmer.setCurrent(word);
    stemmer.stem();
    return stemmer.getCurrent();
}
//# sourceMappingURL=english.js.map