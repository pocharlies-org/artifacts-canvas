import { RoomCore } from '../../src/room-core.js';
import { SCAN_WORK_NS, SPLIT_WORK_NS } from '../../src/config.js';

/**
 * A room's documents as its worker holds them (fv9: RoomCore), with the server's default guard
 * caps: for seeding stored rooms through the real stamper and for in-process probes.
 */
export function testCore(maxApplyMs = 50): RoomCore {
  return new RoomCore({
    attributionRetentionDays: 30,
    maxSplits: 5000,
    maxSplitWork: (maxApplyMs * 1e6) / SPLIT_WORK_NS,
    maxScanWork: (maxApplyMs * 1e6) / SCAN_WORK_NS,
    maxClients: 256,
  });
}
