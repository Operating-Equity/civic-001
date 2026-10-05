// Doors to FactEngine's tool server, one for each listing, for a provider whose servers call the tool server with no
// header of ours. Fireworks' do not forward an `mcp` entry's headers: on 5 October its servers called /mcp ten times
// during the first live listing, each time without the pass, and each was refused. So a listing's request names an
// address with a door of its own in it, /mcp/t/<door>: 24 random bytes, open from the moment the request is made until
// that reply ends, then closed, after which the address answers no one. No pass leaves the server, and a door read later
// from a log or a record opens nothing.
//
// The doors live in this process, as the listings do: a listing and its door belong to one instance (Render runs one;
// after a deploy, the new instance's listings open their own).
import crypto from 'node:crypto';

const open = new Set();

/** A door for one listing: its id (for the address) and the call that closes it. */
export function openDoor() {
  const id = crypto.randomBytes(24).toString('hex');
  open.add(id);
  return { id, close: () => { open.delete(id); } };
}

/** Whether the door in an address is open, compared in constant time with each open door. */
export function isOpen(given) {
  const g = Buffer.from(String(given || ''));
  let found = false;
  for (const id of open) {
    const d = Buffer.from(id);
    if (g.length === d.length && crypto.timingSafeEqual(g, d)) found = true;
  }
  return found;
}

/** How many doors are open now: one for each listing on Fireworks in flight (/check). */
export const doorsOpen = () => open.size;
