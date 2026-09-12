'use strict';
// Cisco 交换机拆线 + 全部 profiles 品类标注（第 3 步品类化分组的数据层）
// 一次性脚本：拆 cisco_01_switches → 园区/数据中心/工业三条线；27+2 文件补 category 字段。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'profiles');

// ① Cisco 拆线：series → 线
function classifyCisco(series) {
  const s = String(series || '');
  if (/Nexus|N9300/i.test(s)) return 'dc';
  if (/Industrial|\bIE\d{4}/i.test(s)) return 'industrial';
  return 'campus'; // Catalyst / C9xxx / Cisco Business
}

// ② 品类映射（文件名 → 标准品类键）
const CATEGORY_BY_FILE = {
  'ale_omniaccess.json': 'wireless_ap',
  'ale_omniswitch.json': 'campus_switch',
  'ale_stellar.json': 'wireless_mgmt',
  'extreme_01_wired_access.json': 'campus_switch',
  'extreme_02_wireless_access.json': 'wireless_ap',
  'extreme_03_management.json': 'mgmt_platform',
  'h3c_01_campus.json': 'campus_switch',
  'h3c_02_datacenter.json': 'dc_switch',
  'h3c_03_industrial.json': 'industrial',
  'h3c_04_others.json': 'other',
  'hpe_aruba_cx_switches.json': 'campus_switch',
  'hpe_aruba_wifi.json': 'wireless_ap',
  'huawei_campus_access.json': 'campus_switch',
  'huawei_campus_industrial.json': 'industrial',
  'huawei_datacenter_switches.json': 'dc_switch',
  'huawei_network_management.json': 'mgmt_platform',
  'huawei_routers.json': 'router',
  'huawei_security.json': 'security',
  'huawei_wlan.json': 'wireless_ap',
  'ruijie_01_campus.json': 'campus_switch',
  'ruijie_02_datacenter.json': 'dc_switch',
  'ruijie_03_wireless.json': 'wireless_ap',
  'ruijie_04_routers.json': 'router',
  'ruijie_05_security.json': 'security',
  'ruijie_06_classroom.json': 'other',
  'ruijie_07_others.json': 'other',
};

const LINE_META = {
  campus: { id: '01', name: '01 园区交换机', category: 'campus_switch' },
  dc: { id: '02', name: '02 数据中心交换机', category: 'dc_switch' },
  industrial: { id: '03', name: '03 工业交换机', category: 'industrial' },
};

// ① Cisco 拆线（documentId 不变，仅归属文件变化）
const ciscoPath = path.join(DIR, 'cisco_01_switches.json');
if (fs.existsSync(ciscoPath)) {
  const profile = JSON.parse(fs.readFileSync(ciscoPath, 'utf8'));
  const buckets = { campus: [], dc: [], industrial: [] };
  for (const source of profile.sources) buckets[classifyCisco(source.series)].push(source);
  for (const [key, meta] of Object.entries(LINE_META)) {
    if (!buckets[key].length) continue;
    const out = {
      ...profile,
      profileId: `cisco_${meta.id}_${key === 'campus' ? 'campus' : key}`,
      displayName: `Cisco ${meta.name.replace(/^\d+\s/, '')}`,
      category: meta.category,
      productLine: { ...profile.productLine, id: meta.id, name: meta.name },
      subseries: { ...profile.subseries, id: `${profile.subseries?.id || 'cisco'}_${meta.id}`, name: meta.name },
      sources: buckets[key],
    };
    const file = `cisco_${meta.id}_${key}.json`;
    fs.writeFileSync(path.join(DIR, file), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.log(`拆出 ${file}: ${buckets[key].length} 条`);
  }
  fs.unlinkSync(ciscoPath);
  console.log('已删除 cisco_01_switches.json');
}

// ② 全量品类标注（含拆出的 cisco 三线）
for (const file of fs.readdirSync(DIR).filter((name) => name.endsWith('.json'))) {
  const full = path.join(DIR, file);
  const profile = JSON.parse(fs.readFileSync(full, 'utf8'));
  const category = CATEGORY_BY_FILE[file]
    || (profile.category && String(profile.category))
    || (profile.vendorId === 'cisco' ? (file.includes('datacenter') ? 'dc_switch' : file.includes('industrial') ? 'industrial' : 'campus_switch') : '');
  if (!category) { console.log('⚠ 跳过（无映射）:', file); continue; }
  if (profile.category === category) continue;
  profile.category = category;
  fs.writeFileSync(full, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  console.log(`标注 ${file}: ${category}`);
}
console.log('完成');
