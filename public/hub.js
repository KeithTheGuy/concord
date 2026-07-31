// The hub connection: your account, your friend tag, the friend graph, and the
// secret code behind each DM. This is a second, always-on WebSocket that lives
// alongside the server/DM socket in app.js, so friend presence and DM pings
// keep arriving no matter which server you happen to be looking at.

// An unnamed group is titled by whoever is in it, like Discord does — which
// means it renames itself as people come and go, and that's fine.
export function groupTitle(group, myUid) {
  if (group.name) return group.name;
  const others = (group.members || []).filter((m) => m.uid !== myUid).map((m) => m.name);
  if (!others.length) return "Empty group";
  if (others.length <= 3) return others.join(", ");
  return `${others.slice(0, 3).join(", ")} +${others.length - 3}`;
}

export class HubConnection {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.state = "idle"; // idle | connecting | open
    this.delay = 1000;
    this.timer = null;
    this.pingTimer = null;

    this.me = null; // {uid, tag, name, avatar, color, status, presence}
    this.friends = new Map(); // uid -> {..user, dm}
    this.incoming = new Map(); // uid -> user (they asked you)
    this.outgoing = new Map(); // uid -> user (you asked them)
    // Unread is keyed by conversation: a friend's uid for a 1:1, a group id
    // for a group. The two namespaces can't collide (group ids start with "g",
    // user ids are UUIDs), so one map covers both.
    this.unread = new Map();
    this.dmCodes = new Map(); // uid -> conversation code
    this.groups = new Map(); // group id -> {id, code, name, icon, owner, members}
  }

  /* ------------------------------ transport ------------------------------ */

  connect() {
    if (this.state !== "idle") return;
    this.state = "connecting";
    const url = `${location.origin.replace(/^http/, "ws")}/ws?hub=1`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.state = "idle";
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.state = "open";
      const saved = this.h.savedAccount();
      const profile = this.h.profile();
      this.send({
        type: "hello",
        uid: saved?.uid || "",
        token: saved?.token || "",
        name: profile.name,
        avatar: profile.avatar,
        color: profile.color,
        status: profile.status || "",
        presence: this.h.presence(),
      });
      this.startPing();
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.state = "idle";
      this.stopPing();
      // Friends we thought were online are now unknowable — assume offline
      // rather than showing a stale green dot.
      for (const f of this.friends.values()) f.online = false;
      this.h.onChange();
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.delay = Math.min(this.delay * 1.6, 15000);
      this.connect();
    }, this.delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"type":"ping"}');
    }, 30000);
  }
  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /* ------------------------------- protocol ------------------------------ */

  handle(m) {
    switch (m.type) {
      case "pong":
        break;

      case "hub-welcome": {
        this.delay = 1000;
        this.me = m.you;
        this.h.rememberAccount(m.you.uid, m.token, m.you.tag);
        this.friends = new Map(m.friends.map((f) => [f.uid, f]));
        for (const f of m.friends) if (f.dm) this.dmCodes.set(f.uid, f.dm);
        this.incoming = new Map(m.incoming.map((u) => [u.uid, u]));
        this.outgoing = new Map(m.outgoing.map((u) => [u.uid, u]));
        this.groups = new Map((m.groups || []).map((g) => [g.id, g]));
        this.unread = new Map(Object.entries(m.dmUnread || {}));
        this.h.onWelcome(m.you);
        this.h.onChange();
        break;
      }

      case "friend-request": {
        this.incoming.set(m.user.uid, m.user);
        this.h.onChange();
        this.h.onRequest(m.user);
        break;
      }

      case "friend-outgoing": {
        this.outgoing.set(m.user.uid, m.user);
        this.h.onChange();
        this.h.toast(`Friend request sent to ${m.user.name}.`);
        break;
      }

      case "friend-added": {
        const uid = m.user.uid;
        this.incoming.delete(uid);
        this.outgoing.delete(uid);
        this.friends.set(uid, m.user);
        if (m.user.dm) this.dmCodes.set(uid, m.user.dm);
        this.h.onChange();
        this.h.toast(`🎉 ${m.user.name} is now your friend.`);
        break;
      }

      case "friend-removed": {
        const known = this.friends.get(m.uid) || this.incoming.get(m.uid) || this.outgoing.get(m.uid);
        this.friends.delete(m.uid);
        this.incoming.delete(m.uid);
        this.outgoing.delete(m.uid);
        this.unread.delete(m.uid);
        this.h.onChange();
        this.h.onFriendRemoved(m.uid, known);
        break;
      }

      case "friend-presence": {
        const f = this.friends.get(m.uid);
        if (f) {
          f.online = m.online;
          if (m.presence) f.presence = m.presence;
          this.h.onChange();
        }
        break;
      }

      case "friend-update": {
        const existing = this.friends.get(m.user.uid);
        if (existing) {
          this.friends.set(m.user.uid, { ...existing, ...m.user });
          this.h.onChange();
        }
        break;
      }

      case "tag-changed": {
        if (this.me) this.me.tag = m.tag;
        this.h.rememberTag(m.tag);
        this.h.onChange();
        this.h.toast(`You are now @${m.tag}.`);
        break;
      }

      case "dm-ready": {
        this.dmCodes.set(m.uid, m.code);
        const f = this.friends.get(m.uid);
        if (f) Object.assign(f, m.user, { dm: m.code });
        this.unread.delete(m.uid);
        this.h.onDmReady(m.uid, m.code, m.user);
        break;
      }

      case "gdm-added": {
        const known = this.groups.has(m.group.id);
        this.groups.set(m.group.id, m.group);
        this.h.onChange();
        if (!known) this.h.toast(`👥 You're in "${groupTitle(m.group, this.me?.uid)}".`);
        break;
      }

      case "gdm-ready": {
        this.groups.set(m.group.id, m.group);
        this.unread.delete(m.group.id);
        this.h.onGroupReady(m.group);
        break;
      }

      case "gdm-removed": {
        const group = this.groups.get(m.id);
        this.groups.delete(m.id);
        this.unread.delete(m.id);
        this.h.onChange();
        this.h.onGroupRemoved(m.id, group);
        break;
      }

      case "dm-nudge": {
        const key = m.gdm || m.uid;
        this.unread.set(key, m.count);
        this.h.onChange();
        this.h.onDmNudge(key, m.name, m.preview, !!m.gdm);
        break;
      }

      case "poked": {
        this.h.onPoked(m.name);
        break;
      }

      // A wake-up, not a ring. All this frame has to do is get the
      // conversation's own socket open; the ring itself is still derived from
      // live voice membership over there, which is why it can't get stuck.
      case "call-ring": {
        // For a 1:1 frame `uid` is both the caller and the conversation key; for a
        // group it's the caller and `gdm` is the key. Same namespace split as unread.
        this.h.onCallRing(m.gdm || m.uid, { from: m.uid, name: m.name, chanId: m.chanId, isGroup: !!m.gdm });
        break;
      }
      case "call-end": {
        this.h.onCallEnd(m.gdm || m.uid, !!m.gdm);
        break;
      }

      case "poke-sent": {
        this.h.toast(m.landed ? "👉 Poked." : "They're offline — poke went nowhere.", !m.landed);
        break;
      }

      case "hub-error": {
        this.h.toast(m.error, true);
        break;
      }
    }
  }

  /* -------------------------------- actions ------------------------------ */

  addFriend(tag) {
    this.send({ type: "friend-add", tag });
  }
  accept(uid) {
    this.send({ type: "friend-accept", uid });
  }
  decline(uid) {
    this.send({ type: "friend-decline", uid });
  }
  remove(uid) {
    this.send({ type: "friend-remove", uid });
  }
  setTag(tag) {
    this.send({ type: "set-tag", tag });
  }
  poke(uid) {
    this.send({ type: "poke", uid });
  }
  // `key` is a friend's uid or a group id, same as everywhere else here.
  ringCall(key, chanId, isGroup) {
    this.send(isGroup ? { type: "call-ring", gdm: key, chanId } : { type: "call-ring", uid: key, chanId });
  }
  endCall(key, isGroup) {
    this.send(isGroup ? { type: "call-end", gdm: key } : { type: "call-end", uid: key });
  }
  openDm(uid) {
    this.send({ type: "dm-open", uid });
  }
  // `key` is a friend's uid or a group id — same unread namespace either way.
  markDmRead(key) {
    if (!this.unread.has(key)) return;
    this.unread.delete(key);
    this.send({ type: "dm-read", uid: key });
    this.h.onChange();
  }
  nudgeDm(uid, preview) {
    this.send({ type: "dm-nudge", uid, preview });
  }

  createGroup(name, uids) {
    this.send({ type: "gdm-create", name, uids });
  }
  openGroup(id) {
    this.send({ type: "gdm-open", id });
  }
  addToGroup(id, uid) {
    this.send({ type: "gdm-add", id, uid });
  }
  renameGroup(id, name) {
    this.send({ type: "gdm-rename", id, name });
  }
  leaveGroup(id) {
    this.send({ type: "gdm-leave", id });
  }
  nudgeGroup(id, preview) {
    this.send({ type: "dm-nudge", gdm: id, preview });
  }
  pushProfile() {
    const p = this.h.profile();
    this.send({
      type: "presence",
      name: p.name,
      avatar: p.avatar,
      color: p.color,
      status: p.status || "",
      presence: this.h.presence(),
    });
  }

  totalUnread() {
    let n = 0;
    for (const v of this.unread.values()) n += v;
    return n;
  }
  pendingCount() {
    return this.incoming.size;
  }
}
