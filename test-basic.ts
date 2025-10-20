/**
 * Basic connectivity test - only tests connection and audio
 */

import { IcomControl, AUDIO_RATE } from './src';

async function testBasic() {
  const ip = process.env.ICOM_IP!;
  const port = parseInt(process.env.ICOM_PORT!, 10);
  const user = process.env.ICOM_USER!;
  const pass = process.env.ICOM_PASS!;

  console.log('🔌 Connecting to', ip, port);
  const rig = new IcomControl({ control: { ip, port }, userName: user, password: pass });

  let audioCount = 0;
  rig.events.on('audio', () => { audioCount++; });
  rig.events.on('login', (res) => console.log('✓ Login:', res.ok ? 'OK' : 'FAILED'));
  rig.events.on('status', (s) => console.log('✓ Status: civPort=', s.civPort, 'audioPort=', s.audioPort));
  rig.events.on('capabilities', (c) => console.log('✓ Capabilities: civAddr=', c.civAddress));

  await rig.connect();

  console.log('⏳ Waiting 5 seconds for audio...');
  await new Promise(r => setTimeout(r, 5000));

  console.log(`📊 Audio frames received: ${audioCount}`);
  console.log('🔌 Disconnecting...');
  await rig.disconnect();
  console.log('✅ Test complete');
}

testBasic().catch(console.error);
