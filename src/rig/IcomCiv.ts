import { CivPacket, OpenClosePacket } from '../core/IcomPackets';
import { Session } from '../core/Session';
import { dbg } from '../utils/debug';

export class IcomCiv {
  public civAddress = 0xA4;
  public supportTX = true;
  private civSeq = 0;
  private idleTimer?: NodeJS.Timeout;
  private openTimer?: NodeJS.Timeout;

  constructor(private sess: Session) {}

  start() {
    this.stop();
    // CIV session watchdog: Keep-alive mechanism to maintain CIV connection
    // Matches FT8CN's startCivDataTimer() implementation:
    // - Checks every 500ms if CIV session is receiving data
    // - If no data received for >2000ms, sends OpenClose(true) to re-establish connection
    // - This prevents silent disconnection where radio stops responding without error
    this.openTimer = setInterval(() => {
      if (Date.now() - this.sess.lastReceivedTime > 2000) {
        dbg('CIV watchdog: No data for >2s, sending OpenClose to keep alive');
        this.sendOpenClose(true);
      }
    }, 500);
  }

  stop() {
    if (this.openTimer) clearInterval(this.openTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.openTimer = undefined; this.idleTimer = undefined;
  }

  sendOpenClose(open: boolean) {
    const magic = open ? 0x04 : 0x00;
    const pkt = OpenClosePacket.toBytes(0, this.sess.localId, this.sess.remoteId, this.civSeq, magic);
    this.civSeq = (this.civSeq + 1) & 0xffff;
    dbg(`CIV -> OpenClose ${open ? 'OPEN' : 'CLOSE'} seq=${this.civSeq - 1}`);
    this.sess.sendTracked(pkt);
  }

  sendCivData(data: Buffer) {
    const pkt = CivPacket.setCivData(0, this.sess.localId, this.sess.remoteId, this.civSeq, data);
    this.civSeq = (this.civSeq + 1) & 0xffff;
    dbg(`CIV -> data len=${data.length} seq=${this.civSeq - 1}`);
    this.sess.sendTracked(pkt);
  }
}
