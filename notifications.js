// notifications.js — shared notification bell for all Miru pages
// Include after config.js and supabase.js on any page

(function() {
  // ── Inject CSS ──────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .notif-btn { position: relative !important; }
    .notif-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #FF7090;
      border: 2px solid #0A0714;
      display: none;
    }
    .notif-panel {
      position: fixed;
      top: 70px;
      right: max(12px, calc(50% - 210px));
      width: 320px;
      max-height: 420px;
      overflow-y: auto;
      background: #100D22;
      border: 1px solid rgba(180,170,255,0.18);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.60);
      z-index: 500;
      display: none;
    }
    .notif-panel.show { display: block; }
    .notif-panel-head {
      padding: 14px 16px 10px;
      font-size: 13px;
      font-weight: 800;
      color: #F0ECFF;
      border-bottom: 1px solid rgba(180,170,255,0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: 'Cabinet Grotesk', sans-serif;
    }
    .notif-mark-all {
      color: #7A72AA;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      background: none;
      border: none;
      font-family: 'Cabinet Grotesk', sans-serif;
    }
    .notif-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(180,170,255,0.06);
      cursor: pointer;
      transition: background 0.13s;
    }
    .notif-item:hover { background: rgba(255,255,255,0.04); }
    .notif-item:last-child { border-bottom: none; }
    .notif-item.unread { background: rgba(184,174,255,0.05); }
    .notif-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
    .notif-body { flex: 1; font-family: 'Cabinet Grotesk', sans-serif; }
    .notif-text { font-size: 13px; font-weight: 700; color: #F0ECFF; line-height: 1.45; margin-bottom: 3px; }
    .notif-time { font-size: 11px; color: #7A72AA; font-weight: 700; }
    .notif-empty { padding: 32px 16px; text-align: center; color: #7A72AA; font-size: 13px; font-weight: 700; font-family: 'Cabinet Grotesk', sans-serif; }
  `;
  document.head.appendChild(style);

  // ── Inject notification panel HTML ──────────────────────────
  const panel = document.createElement('div');
  panel.className = 'notif-panel';
  panel.id = 'miruNotifPanel';
  panel.innerHTML = `
    <div class="notif-panel-head">
      Notifications
      <button class="notif-mark-all" onclick="miruNotif.markAllRead()">Mark all read</button>
    </div>
    <div id="miruNotifList"><div class="notif-empty">Loading…</div></div>
  `;
  document.body.appendChild(panel);

  // Close panel when clicking outside
  document.addEventListener('click', e => {
    const p = document.getElementById('miruNotifPanel');
    if (!p) return;
    if (!p.contains(e.target) && !e.target.closest('.notif-btn')) {
      p.classList.remove('show');
    }
  });

  // ── Helpers ─────────────────────────────────────────────────
  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function notifIcon(type) {
    const icons = { match: '💜', like: '❤️', message: '💬', superlike: '⭐', default: '🔔' };
    return icons[type] || icons.default;
  }

  // ── Public API ───────────────────────────────────────────────
  window.miruNotif = {
    sb: null,
    userId: null,

    async init() {
      try {
        this.sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY || window.SUPABASE_KEY);
        const { data: { user } } = await this.sb.auth.getUser();
        if (!user) return;
        this.userId = user.id;
        await this.load();
      } catch(e) { console.error('[miruNotif]', e); }
    },

    async load() {
      try {
        const { data } = await this.sb.from('notifications')
          .select('*')
          .eq('user_id', this.userId)
          .order('created_at', { ascending: false })
          .limit(20);

        if (!data) return;

        // Update badge
        const unread = data.filter(n => !n.read).length;
        document.querySelectorAll('.notif-badge').forEach(b => {
          b.style.display = unread > 0 ? 'block' : 'none';
        });

        // Render list
        const list = document.getElementById('miruNotifList');
        if (!list) return;

        if (data.length === 0) {
          list.innerHTML = '<div class="notif-empty">No notifications yet 🔔</div>';
          return;
        }

        list.innerHTML = data.map(n => `
          <div class="notif-item ${n.read ? '' : 'unread'}" onclick="miruNotif.markRead('${n.id}', '${n.type}')">
            <div class="notif-icon">${notifIcon(n.type)}</div>
            <div class="notif-body">
              <div class="notif-text">${n.message}</div>
              <div class="notif-time">${timeAgo(n.created_at)}</div>
            </div>
          </div>
        `).join('');
      } catch(e) { console.error('[miruNotif load]', e); }
    },

    async markRead(id, type) {
      await this.sb.from('notifications').update({ read: true }).eq('id', id);
      if (type === 'message') window.location.href = 'messages.html';
      if (type === 'match') window.location.href = 'index.html';
      await this.load();
    },

    async markAllRead() {
      await this.sb.from('notifications').update({ read: true }).eq('user_id', this.userId);
      await this.load();
    },

    toggle() {
      const p = document.getElementById('miruNotifPanel');
      const wasOpen = p.classList.contains('show');
      p.classList.toggle('show');
      if (!wasOpen) this.load();
    }
  };

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => miruNotif.init());
  } else {
    miruNotif.init();
  }
})();
