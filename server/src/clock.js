'use strict';
// 可注入时钟，保证"截止时点/负责人沿革/签收"的时间语义可测
let now = () => new Date();
function nowIso() { return now().toISOString(); }
function setClock(fn) { now = fn; }
module.exports = { now: () => now(), nowIso, setClock };
