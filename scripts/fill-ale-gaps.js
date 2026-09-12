'use strict';
// 填充 ALE 两条空占位产品线（全部直链已 curl HEAD 验证 200 + application/pdf）：
// - ale_omniaccess：OmniAccess Stellar 现役 AP 家族 ×12（官方 -/media 资产域）
// - ale_stellar：Stellar WLAN 的管理产品 = OmniVista Terra/2500（ALE 无独立 Stellar
//   网管设备——Stellar 是 AP 内嵌分布式控制，管理由 OmniVista 承担，如实登记）
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'profiles');
const MEDIA = 'https://www.al-enterprise.com/-/media/assets/internet/documents';
const PAGE = 'https://www.al-enterprise.com/en/products/wlan';

// 直链均已 HEAD 验证（200 application/pdf）
const APS = [
  { model: 'AP1501', gen: 'Wi-Fi 7 室内', file: 'omniaccess-stellar-oaw-ap1501-datasheet-en.pdf' },
  { model: 'AP1511', gen: 'Wi-Fi 7 室内', file: 'omniaccess-stellar-oaw-ap1511-datasheet-en.pdf' },
  { model: 'AP1521', gen: 'Wi-Fi 7 室内', file: 'omniaccess-stellar-oaw-ap1521-datasheet-en.pdf' },
  { model: 'AP1540', gen: 'Wi-Fi 7 室内系列', file: 'omniaccess-stellar-oaw-ap1540-datasheet-en.pdf' },
  { model: 'AP1431', gen: 'Wi-Fi 6E 室内', file: 'omniaccess-stellar-oaw-ap1431-datasheet-en.pdf' },
  { model: 'AP1451', gen: 'Wi-Fi 6E 室内', file: 'omniaccess-stellar-oaw-ap1451-datasheet-en.pdf' },
  { model: 'AP1301', gen: 'Wi-Fi 6 室内', file: 'omniaccess-stellar-ap1301-datasheet-en.pdf' },
  { model: 'AP1331', gen: 'Wi-Fi 6 室内', file: 'omniaccess-stellar-oaw-ap1331-datasheet-en.pdf' },
  { model: 'AP1351', gen: 'Wi-Fi 6 室内', file: 'omniaccess-stellar-oaw-ap1351-datasheet-en.pdf' },
  { model: 'AP1360', gen: 'Wi-Fi 6 室外 IP67', file: 'omniaccess-stellar-oaw-ap1360-datasheet-en.pdf' },
  { model: 'AP1561', gen: 'Wi-Fi 7 室外', file: 'omniaccess-stellar-oaw-ap1561-datasheet-en.pdf' },
  { model: 'AP1570', gen: 'Wi-Fi 7 室外系列', file: 'omniaccess-stellar-oaw-ap1570-datasheet-en.pdf' },
  { model: 'AP1261', gen: '802.11ac wave2 室外', file: 'omniaccess-stellar-oaw-ap1261-datasheet-en.pdf' },
];

// ① OmniAccess 无线接入
const omniPath = path.join(DIR, 'ale_omniaccess.json');
const omni = JSON.parse(fs.readFileSync(omniPath, 'utf8'));
omni.sources = APS.map((ap) => ({
  documentId: `ale-omniaccess_${ap.model.toLowerCase()}-datasheet`,
  series: `OmniAccess Stellar ${ap.model}`,
  modelNames: [`OmniAccess Stellar ${ap.model}`],
  description: `OmniAccess Stellar ${ap.model}（${ap.gen}）官方 datasheet`,
  productPageUrl: `${PAGE}/omniaccess-stellar-access-point-${ap.model.toLowerCase()}`,
  materialPageUrl: '',
  pdfUrl: `${MEDIA}/${ap.file}`,
  officialFileName: ap.file,
  matchTerms: [`OmniAccess Stellar ${ap.model}`, ap.model],
  evidencePolicy: 'official_datasheet',
  expectedSha256: '',
}));
fs.writeFileSync(omniPath, `${JSON.stringify(omni, null, 2)}\n`, 'utf8');
console.log(`ale_omniaccess: 登记 ${omni.sources.length} 条`);

// ② Stellar 无线网络管理（= OmniVista 管理 Stellar WLAN）
const stellarPath = path.join(DIR, 'ale_stellar.json');
const stellar = JSON.parse(fs.readFileSync(stellarPath, 'utf8'));
stellar.sources = [
  {
    documentId: 'ale-stellar_omnivista-terra',
    series: 'OmniVista Terra',
    modelNames: ['OmniVista Terra'],
    description: 'OmniVista Terra 网络管理套件：Stellar AP 与 OmniSwitch 的编排管理（云/虚拟化）官方 datasheet',
    productPageUrl: '',
    materialPageUrl: '',
    pdfUrl: `${MEDIA}/omnivista-terra-network-management-datasheet-en.pdf`,
    officialFileName: 'omnivista_terra-network-management-datasheet-en.pdf',
    matchTerms: ['OmniVista Terra', 'Stellar WLAN management'],
    evidencePolicy: 'official_datasheet',
    expectedSha256: '',
  },
  {
    documentId: 'ale-stellar_omnivista-2500',
    series: 'OmniVista 2500 NMS',
    modelNames: ['OmniVista 2500'],
    description: 'OmniVista 2500 NMS：Stellar WLAN 的 RF 管理/WIDS-WIPS/热图（硬件或虚拟设备）官方 datasheet',
    productPageUrl: 'https://www.al-enterprise.com/en/products/network-management-security/omnivista-2500-network-management-system',
    materialPageUrl: '',
    pdfUrl: `${MEDIA}/omnivista-2500-nms-datasheet-en.pdf`,
    officialFileName: 'omnivista_2500-nms-datasheet-en.pdf',
    matchTerms: ['OmniVista 2500', 'Stellar WLAN management'],
    evidencePolicy: 'official_datasheet',
    expectedSha256: '',
  },
];
fs.writeFileSync(stellarPath, `${JSON.stringify(stellar, null, 2)}\n`, 'utf8');
console.log(`ale_stellar: 登记 ${stellar.sources.length} 条`);
