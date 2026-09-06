'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { autoAssign, matchDocuments, normalizeName, scoreMatch } = require('../lib/match');

const DOCS = [
  { documentId: 'h3c-1', vendorName: '新华三 H3C', series: 'S1000', officialFileName: 'H3C S1000-datasheet.pdf', modelNames: ['S1000-8'] },
  { documentId: 'h3c-2', vendorName: '新华三 H3C', series: 'S1300_1200', officialFileName: 'H3C S1300_1200-datasheet.pdf', modelNames: ['S1300'] },
  { documentId: 'ale-1', vendorName: 'ALE', series: 'OmniSwitch 2260', officialFileName: 'os2260-datasheet-4f44c6633388.pdf', modelNames: ['OS2260-10'] },
  { documentId: 'cisco-1', vendorName: 'Cisco', series: 'Catalyst 9300', officialFileName: 'catalyst-9300-datasheet.pdf', modelNames: ['C9300-48P'] },
];

test('normalizeName：扩展名与分隔符统一', () => {
  assert.equal(normalizeName('H3C S1000-Datasheet.PDF'), 'h3c s1000 datasheet');
  assert.equal(normalizeName('os2260_datasheet__v2.pdf'), 'os2260 datasheet v2');
});

test('scoreMatch：登记文件名精确命中 100 分（叠加系列名共 150）', () => {
  const { score, reasons } = scoreMatch('H3C S1000-datasheet.pdf', DOCS[0]);
  assert.equal(score, 150);
  assert.match(reasons.join(''), /完全一致/);
  assert.match(reasons.join(''), /系列名/);
});

test('matchDocuments：官网原名、含系列名、含型号三种真实命名都能排到正确第一', () => {
  const byOfficial = matchDocuments('H3C S1000-datasheet.pdf', DOCS);
  assert.equal(byOfficial[0].documentId, 'h3c-1');
  const bySeries = matchDocuments('新华三 S1000 交换机彩页.pdf', DOCS);
  assert.equal(bySeries[0].documentId, 'h3c-1');
  assert.match(bySeries[0].reasons.join(''), /系列名/);
  const byModel = matchDocuments('c9300-48p datasheet.pdf', DOCS);
  assert.equal(byModel[0].documentId, 'cisco-1');
  const ale = matchDocuments('OmniSwitch 2260 产品彩页.pdf', DOCS);
  assert.equal(ale[0].documentId, 'ale-1');
});

test('matchDocuments：低分候选被过滤，分数排序稳定', () => {
  const candidates = matchDocuments('完全无关的文件名.pdf', DOCS);
  assert.equal(candidates.length, 0, '无任何词命中应无候选');
});

test('autoAssign：高置信领先才机器拍板，同分交人工', () => {
  assert.equal(autoAssign([{ documentId: 'a', score: 100 }, { documentId: 'b', score: 40 }]), 'a');
  assert.equal(autoAssign([{ documentId: 'a', score: 60 }, { documentId: 'b', score: 55 }]), '', '分数接近应交人工');
  assert.equal(autoAssign([{ documentId: 'a', score: 60 }]), '', '低于 80 分不自动');
  assert.equal(autoAssign([]), '');
});
