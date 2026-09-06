'use strict';
// 临时探测脚本：查看远端 8788 占用与容器清单（用后即删）
const { Client } = require('F:/AIwork/ZCode/NVCI/tools/node_modules/ssh2');
const conn = new Client();
conn.on('ready', () => {
  conn.exec('ss -tlnp | grep 8788; echo ---DOCKER---; docker ps --format "{{.Names}} -> {{.Ports}}"; echo ---DIR---; ls /vol1/1000/docker', (err, stream) => {
    if (err) { console.error('EXEC_ERR', err.message); process.exit(1); }
    let out = '';
    stream.on('close', (code) => { console.log('exit', code); console.log(out); conn.end(); }).on('data', (d) => { out += d; });
    stream.stderr.on('data', (d) => { out += `[stderr] ${d}`; });
  });
}).on('error', (e) => { console.error('CONN_ERR', e.message); process.exit(1); }).connect({
  host: '10.20.30.203', port: 22, username: 'alec', password: 'P@ssw0rd@5121', readyTimeout: 20000,
});
