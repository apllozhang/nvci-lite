'use strict';
// 生成 Juniper 内置品牌五条产品线（全部直链已 curl HEAD 验证 200 + application/pdf，
// juniper.net/documentation 本域官方硬件指南 PDF；ACX7100 404 未收录）。
// EX4400 的 -datasheet.html 产品页已 301 至 HPE PS Now（并购迁移），故
// trustedRedirectDomains 保留 hpe.com；本批 PDF 全部本域 200，无跳转。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'profiles');
const DOC = 'https://www.juniper.net/documentation/us/en/hardware';
const PAGE = 'https://www.juniper.net/documentation/product/us/en';

const LINES = [
  {
    file: 'juniper_01_campus.json',
    lineId: '01', lineName: '01 园区交换机', category: 'campus_switch',
    sub: 'EX 系列园区交换机',
    sources: [
      { model: 'EX4100', models: ['EX4100', 'EX4100-F'], page: `${PAGE}/ex4100/`, desc: 'EX4100 园区接入交换机（含 EX4100-F 分支型）官方硬件指南' },
      { model: 'EX4400', models: ['EX4400'], page: `${PAGE}/ex4400/`, desc: 'EX4400 园区接入/汇聚交换机（虚拟机箱）官方硬件指南' },
      { model: 'EX4650', models: ['EX4650'], page: `${PAGE}/ex4650/`, desc: 'EX4650 园区汇聚/核心交换机官方硬件指南' },
    ],
  },
  {
    file: 'juniper_02_dc.json',
    lineId: '02', lineName: '02 数据中心交换机', category: 'dc_switch',
    sub: 'QFX 系列数据中心交换机',
    sources: [
      { model: 'QFX5120', models: ['QFX5120'], page: `${PAGE}/qfx5120/`, desc: 'QFX5120 数据中心 ToR/汇聚交换机官方硬件指南' },
      { model: 'QFX5130', models: ['QFX5130'], page: `${PAGE}/qfx5130/`, desc: 'QFX5130 数据中心交换机（100G/400G）官方硬件指南' },
      { model: 'QFX5220', models: ['QFX5220'], page: `${PAGE}/qfx5220/`, desc: 'QFX5220 数据中心交换机（400G）官方硬件指南' },
      { model: 'QFX5700', models: ['QFX5700'], page: `${PAGE}/qfx5700/`, desc: 'QFX5700 数据中心核心交换机官方硬件指南' },
    ],
  },
  {
    file: 'juniper_03_routers.json',
    lineId: '03', lineName: '03 路由器', category: 'router',
    sub: 'MX/ACX 系列路由器',
    sources: [
      { model: 'MX204', models: ['MX204'], page: `${PAGE}/mx204/`, desc: 'MX204 边缘路由器官方硬件指南' },
      { model: 'MX304', models: ['MX304'], page: `${PAGE}/mx304/`, desc: 'MX304 边缘路由器官方硬件指南' },
      { model: 'ACX7024', models: ['ACX7024'], page: `${PAGE}/acx7024/`, desc: 'ACX7024 汇聚/聚合路由器官方硬件指南' },
    ],
  },
  {
    file: 'juniper_04_security.json',
    lineId: '04', lineName: '04 安全网关', category: 'security',
    sub: 'SRX 系列防火墙',
    sources: [
      { model: 'SRX1500', models: ['SRX1500'], page: `${PAGE}/srx1500/`, desc: 'SRX1500 下一代防火墙官方硬件指南' },
      { model: 'SRX1600', models: ['SRX1600'], page: `${PAGE}/srx1600/`, desc: 'SRX1600 下一代防火墙官方硬件指南' },
      { model: 'SRX2300', models: ['SRX2300'], page: `${PAGE}/srx2300/`, desc: 'SRX2300 下一代防火墙官方硬件指南' },
      { model: 'SRX4300', models: ['SRX4300'], page: `${PAGE}/srx4300/`, desc: 'SRX4300 下一代防火墙官方硬件指南' },
      { model: 'SRX4600', models: ['SRX4600'], page: `${PAGE}/srx4600/`, desc: 'SRX4600 下一代防火墙官方硬件指南' },
    ],
  },
  {
    file: 'juniper_05_wireless.json',
    lineId: '05', lineName: '05 无线接入点', category: 'wireless_ap',
    sub: 'Mist 系列无线接入点',
    sources: [
      { model: 'AP34', models: ['Mist AP34'], page: `${PAGE}/ap34/`, desc: 'Mist AP34 Wi-Fi 6/6E 接入点官方硬件指南' },
      { model: 'AP45', models: ['Mist AP45'], page: `${PAGE}/ap45/`, desc: 'Mist AP45 Wi-Fi 6/6E 接入点官方硬件指南' },
    ],
  },
];

for (const line of LINES) {
  const profile = {
    schemaVersion: '2.2',
    profileId: `juniper_${line.lineId}_${line.file.match(/juniper_\d+_(\w+)\.json/)[1]}`,
    vendorId: 'juniper',
    vendorName: 'Juniper Networks',
    displayName: `Juniper ${line.lineName.replace(/^\d+\s/, '')}`,
    category: line.category,
    mode: 'public_official_pdf_incremental',
    officialDomains: ['www.juniper.net', 'juniper.net'],
    // 并购迁移期：部分产品页 301 至 hpe.com（PDF 直链全部本域 200，此字段仅作跳转兜底）
    trustedRedirectDomains: ['www.hpe.com', 'hpe.com'],
    sourcePolicy: '仅采集已登记的公开官方 PDF；PDF 为 juniper.net documentation 域官方硬件指南，含完整硬件规格。',
    evidencePolicy: 'official_hardware_guide',
    productLine: { id: line.lineId, name: line.lineName, libraryRootName: 'Juniper产品彩页' },
    subseries: { id: line.lineId, name: line.sub },
    sources: line.sources.map((item) => ({
      documentId: `juniper_${item.model.toLowerCase()}-hwguide`,
      series: item.model,
      modelNames: item.models,
      description: item.desc,
      productPageUrl: item.page,
      materialPageUrl: '',
      pdfUrl: `${DOC}/${item.model.toLowerCase()}/${item.model.toLowerCase()}.pdf`,
      officialFileName: `${item.model.toLowerCase()}-hardware-guide.pdf`,
      evidencePolicy: 'official_hardware_guide',
      expectedSha256: '',
    })),
  };
  fs.writeFileSync(path.join(DIR, line.file), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  console.log(`生成 ${line.file}: ${profile.sources.length} 条（${profile.category}）`);
}
