/**
 * NexusComments - 产品无关的博客/产品评论组件（纯 vanilla JS，零依赖）
 *
 * 设计约定（遵循 NEXUS common 层规则）：
 *  1. 样式绝不写死：所有可视差异走 `classNames` 注入 + CSS 变量 `--nxc-*`
 *  2. 文案绝不写死：所有中文默认值可被 `labels` 覆盖
 *  3. XSS 铁律：用户数据一律 textContent / createElement 渲染，全文件不出现拼接用户数据的 innerHTML
 *
 * 用法（静态站）：
 *   <div id="comments"></div>
 *   <script src="comment-widget.js"></script>
 *   <script>NexusComments.init({ el: '#comments', apiBase: '/api/comments' });</script>
 *
 * 用法（React）：见同目录 CommentSection.jsx
 */
(function (global) {
  'use strict';

  /** localStorage key 前缀（避免污染宿主页面） */
  var LS_PREFIX = 'nexus_comments_';

  /** 默认文案（全部可通过 options.labels 覆盖） */
  var DEFAULT_LABELS = {
    title: '条评论',
    nick: '昵称（选填）',
    email: '邮箱（选填）',
    website: '网址（选填）',
    submit: '发表评论',
    submitting: '提交中…',
    reply: '回复',
    cancel: '取消',
    loadMore: '加载更多',
    loading: '加载中…',
    empty: '还没有评论，来抢沙发',
    pending: '评论已提交，审核后显示',
    retry: '重试',
    loadError: '评论加载失败',
    errNickTooLong: '昵称最多 50 个字',
    errContentRequired: '请填写评论内容',
    errContentTooLong: '评论内容最多 3000 个字',
    errEmailRequired: '请填写邮箱',
    errEmailInvalid: '邮箱格式不正确',
    errNetwork: '网络异常，请稍后重试',
    errRateLimit: '发言太快了，请稍后再试',
    justNow: '刚刚',
    minutesAgo: '分钟前',
    hoursAgo: '小时前',
    daysAgo: '天前'
  };

  /** 默认类名（产品可通过 options.classNames 逐个覆盖/追加） */
  var DEFAULT_CLASSNAMES = {
    root: '',
    header: '',
    count: '',
    form: '',
    metaRow: '',
    input: '',
    textarea: '',
    submit: '',
    cancel: '',
    error: '',
    notice: '',
    list: '',
    item: '',
    avatar: '',
    itemMain: '',
    itemHead: '',
    author: '',
    time: '',
    content: '',
    replyBtn: '',
    replies: '',
    replyItem: '',
    replyTo: '',
    loadMore: '',
    empty: '',
    listError: ''
  };

  var MAX_NICK = 50;
  var MAX_CONTENT = 3000;
  /** 粗校验即可（后端还有一层严格校验） */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ---------------------------------------------------------------------------
  // 通用小工具
  // ---------------------------------------------------------------------------

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  /**
   * 创建元素。className 支持基础类 + 注入类拼接。
   * 注意：文本一律走 textContent（构造时赋值），不接受 HTML 字符串。
   */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  /** 规范化 path：去掉结尾 index.html，确保以 / 结尾 */
  function normalizePath(p) {
    var path = p || '/';
    path = path.replace(/index\.html?$/i, '');
    if (path.charAt(path.length - 1) !== '/') path += '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    return path;
  }

  /**
   * 只允许 http:// 和 https:// 开头的链接（防 javascript: / data: XSS）。
   * 返回安全 URL 字符串，不安全返回 null。
   */
  function safeHttpUrl(url) {
    if (!url || typeof url !== 'string') return null;
    var trimmed = url.trim();
    // 显式白名单：必须以 http:// 或 https:// 开头（大小写不敏感）
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
  }

  /** 解析后端的 "YYYY-MM-DD HH:MM:SS"（跨浏览器安全，Safari 不认空格分隔） */
  function parseTime(str) {
    if (!str) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(str));
    if (!m) {
      var d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  /** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / 超过 30 天显示原文日期 */
  function relativeTime(str, labels) {
    var d = parseTime(str);
    if (!d) return str || '';
    var diff = Date.now() - d.getTime();
    if (diff < 0) return labels.justNow;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return labels.justNow;
    if (mins < 60) return mins + labels.minutesAgo;
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + labels.hoursAgo;
    var days = Math.floor(hours / 24);
    if (days <= 30) return days + labels.daysAgo;
    return String(str).slice(0, 10);
  }

  function lsGet(key) {
    try {
      return global.localStorage.getItem(LS_PREFIX + key) || '';
    } catch (e) {
      return '';
    }
  }

  function lsSet(key, value) {
    try {
      global.localStorage.setItem(LS_PREFIX + key, value == null ? '' : String(value));
    } catch (e) {
      /* 隐私模式 / 禁用 storage 时静默降级，不影响评论功能 */
    }
  }

  // ---------------------------------------------------------------------------
  // Widget
  // ---------------------------------------------------------------------------

  /**
   * @param {Object} options 见 README
   * @constructor
   */
  function CommentWidget(options) {
    var opts = options || {};

    var container =
      typeof opts.el === 'string' ? document.querySelector(opts.el) : opts.el;
    if (!container) throw new Error('[NexusComments] 找不到容器元素 options.el');
    if (!opts.apiBase) throw new Error('[NexusComments] 缺少必填参数 options.apiBase');

    this.container = container;
    this.apiBase = String(opts.apiBase).replace(/\/+$/, '');
    this.path = normalizePath(
      opts.path || (global.location ? global.location.pathname : '/')
    );
    this.pageSize = opts.pageSize > 0 ? opts.pageSize : 10;
    this.placeholder = opts.placeholder || '说点什么…';
    this.requireEmail = !!opts.requireEmail;
    this.labels = assign({}, DEFAULT_LABELS, opts.labels);
    this.cls = assign({}, DEFAULT_CLASSNAMES, opts.classNames);
    this.avatarBase = opts.avatarBase || 'https://cravatar.cn/avatar/';
    // 主题：'light'（默认）| 'dark'（强制暗）| 'auto'（跟随系统）。
    // 默认不跟随系统——宿主页面配色多为固定，widget 单方面跟随系统会在
    // 浅色页面里渲染出一块黑（2026-08-07 博客实际踩到），auto 必须显式选择。
    this.theme = opts.theme === 'dark' || opts.theme === 'auto' ? opts.theme : 'light';

    this.page = 1;
    this.total = 0;
    this.loaded = 0;
    this.destroyed = false;
    /** 顶层评论 id -> 其 replies 容器 DOM，用于就地插入新回复 */
    this.replyBoxes = {};
    /** 当前展开的内联回复表单（同时只允许一个） */
    this.activeReplyForm = null;
    this.errorTimer = null;

    this._build();
    this._fetchPage(1, true);
  }

  /** 拼接基础类 + 注入类 */
  CommentWidget.prototype._c = function (key, base) {
    var injected = this.cls[key];
    return injected ? base + ' ' + injected : base;
  };

  // ---- 骨架 ---------------------------------------------------------------

  CommentWidget.prototype._build = function () {
    var self = this;
    var root = el('div', this._c('root', 'nxc-root'));
    root.setAttribute('data-nxc-theme', this.theme);
    this.root = root;

    // 标题行
    var header = el('div', this._c('header', 'nxc-header'));
    this.countEl = el('span', this._c('count', 'nxc-count'), '0 ' + this.labels.title);
    header.appendChild(this.countEl);
    root.appendChild(header);

    // 顶层发表表单
    this.mainForm = this._buildForm(null, function (data, pending) {
      self._onPosted(data, pending, null);
    });
    root.appendChild(this.mainForm.wrap);

    // 列表
    this.listEl = el('div', this._c('list', 'nxc-list'));
    root.appendChild(this.listEl);

    // 加载更多
    this.loadMoreBtn = el(
      'button',
      this._c('loadMore', 'nxc-load-more'),
      this.labels.loadMore
    );
    this.loadMoreBtn.type = 'button';
    this.loadMoreBtn.style.display = 'none';
    this._on(this.loadMoreBtn, 'click', function () {
      self._fetchPage(self.page + 1, false);
    });
    root.appendChild(this.loadMoreBtn);

    this.container.appendChild(root);
  };

  /** 统一登记事件，destroy 时全部解绑 */
  CommentWidget.prototype._on = function (node, type, handler) {
    if (!this._listeners) this._listeners = [];
    node.addEventListener(type, handler);
    this._listeners.push([node, type, handler]);
  };

  // ---- 表单 ---------------------------------------------------------------

  /**
   * 构建一套表单（顶层 / 内联回复共用）
   * @param {number|null} parentId 顶层评论 id（回复时传），顶层发表传 null
   * @param {Function} onSuccess (data, pending) => void
   * @param {Function} [onCancel] 提供则渲染取消按钮
   */
  CommentWidget.prototype._buildForm = function (parentId, onSuccess, onCancel) {
    var self = this;
    var L = this.labels;

    var wrap = el('div', this._c('form', 'nxc-form'));

    // meta 行：昵称 / 邮箱 / 网址
    var metaRow = el('div', this._c('metaRow', 'nxc-meta-row'));
    var nickInput = el('input', this._c('input', 'nxc-input'));
    nickInput.type = 'text';
    nickInput.placeholder = L.nick;
    nickInput.maxLength = MAX_NICK;
    nickInput.autocomplete = 'nickname';
    nickInput.value = lsGet('nick');

    var emailInput = el('input', this._c('input', 'nxc-input'));
    emailInput.type = 'email';
    emailInput.placeholder = L.email;
    emailInput.autocomplete = 'email';
    emailInput.value = lsGet('email');

    var siteInput = el('input', this._c('input', 'nxc-input'));
    siteInput.type = 'url';
    siteInput.placeholder = L.website;
    siteInput.autocomplete = 'url';
    siteInput.value = lsGet('website');

    metaRow.appendChild(nickInput);
    metaRow.appendChild(emailInput);
    metaRow.appendChild(siteInput);
    wrap.appendChild(metaRow);

    // 蜜罐：绝对定位移出屏幕（而非 display:none —— 部分 bot 会跳过 display:none 字段）
    var honeypot = el('input', 'nxc-hp');
    honeypot.type = 'text';
    honeypot.name = 'website';
    honeypot.tabIndex = -1;
    honeypot.setAttribute('aria-hidden', 'true');
    honeypot.setAttribute('autocomplete', 'off');
    wrap.appendChild(honeypot);

    var textarea = el('textarea', this._c('textarea', 'nxc-textarea'));
    textarea.placeholder = this.placeholder;
    textarea.rows = 4;
    wrap.appendChild(textarea);

    var actions = el('div', 'nxc-actions');
    var submitBtn = el('button', this._c('submit', 'nxc-submit'), L.submit);
    submitBtn.type = 'button';
    actions.appendChild(submitBtn);

    if (onCancel) {
      var cancelBtn = el('button', this._c('cancel', 'nxc-cancel'), L.cancel);
      cancelBtn.type = 'button';
      this._on(cancelBtn, 'click', function () {
        onCancel();
      });
      actions.appendChild(cancelBtn);
    }
    wrap.appendChild(actions);

    var msgEl = el('div', this._c('error', 'nxc-msg'));
    msgEl.style.display = 'none';
    wrap.appendChild(msgEl);

    var form = {
      wrap: wrap,
      nick: nickInput,
      email: emailInput,
      site: siteInput,
      honeypot: honeypot,
      textarea: textarea,
      submit: submitBtn,
      msg: msgEl,
      busy: false
    };

    this._on(submitBtn, 'click', function () {
      self._submit(form, parentId, onSuccess);
    });

    return form;
  };

  /** 表单提示（error / notice 两态），几秒后自动消失 */
  CommentWidget.prototype._showMsg = function (form, text, isError) {
    var self = this;
    form.msg.textContent = text;
    form.msg.className = isError
      ? this._c('error', 'nxc-msg nxc-msg-error')
      : this._c('notice', 'nxc-msg nxc-msg-notice');
    form.msg.style.display = '';
    if (form._msgTimer) clearTimeout(form._msgTimer);
    form._msgTimer = setTimeout(function () {
      if (self.destroyed) return;
      form.msg.style.display = 'none';
      form.msg.textContent = '';
    }, 5000);
  };

  /** 前端一层校验（后端还有一层） */
  CommentWidget.prototype._validate = function (form) {
    var L = this.labels;
    var nick = form.nick.value.trim();
    var email = form.email.value.trim();
    var content = form.textarea.value.trim();

    if (nick.length > MAX_NICK) return L.errNickTooLong;
    if (!content) return L.errContentRequired;
    if (content.length > MAX_CONTENT) return L.errContentTooLong;
    if (this.requireEmail && !email) return L.errEmailRequired;
    if (email && !EMAIL_RE.test(email)) return L.errEmailInvalid;
    return null;
  };

  CommentWidget.prototype._submit = function (form, parentId, onSuccess) {
    var self = this;
    var L = this.labels;
    if (form.busy) return;

    var err = this._validate(form);
    if (err) {
      this._showMsg(form, err, true);
      return;
    }

    var nick = form.nick.value.trim();
    var email = form.email.value.trim();
    var site = form.site.value.trim();

    lsSet('nick', nick);
    lsSet('email', email);
    lsSet('website', site);

    var body = {
      path: this.path,
      author_name: nick,
      author_email: email,
      author_website: site,
      content: form.textarea.value.trim(),
      website: form.honeypot.value || '' // 蜜罐，正常用户永远是空串
    };
    if (parentId != null) body.parent_id = parentId;

    form.busy = true;
    form.submit.disabled = true;
    form.submit.textContent = L.submitting;

    fetch(this.apiBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().then(
          function (json) {
            return { status: res.status, json: json };
          },
          function () {
            return { status: res.status, json: null };
          }
        );
      })
      .then(function (r) {
        if (self.destroyed) return;
        var json = r.json;
        if (r.status === 429) {
          self._showMsg(form, (json && json.error) || L.errRateLimit, true);
          return;
        }
        if (!json || !json.success) {
          self._showMsg(form, (json && json.error) || L.errNetwork, true);
          return;
        }
        form.textarea.value = '';
        if (json.pending) {
          self._showMsg(form, json.message || L.pending, false);
          onSuccess(null, true);
        } else {
          onSuccess(json.data, false);
        }
      })
      .catch(function () {
        if (self.destroyed) return;
        self._showMsg(form, L.errNetwork, true);
      })
      .then(function () {
        if (self.destroyed) return;
        form.busy = false;
        form.submit.disabled = false;
        form.submit.textContent = L.submit;
      });
  };

  /** 发表成功后就地插入（顶层插最前，回复插到对应 replies 末尾） */
  CommentWidget.prototype._onPosted = function (data, pending, parentId) {
    if (pending || !data) return;

    if (parentId == null) {
      var node = this._renderItem(data);
      var empty = this.listEl.querySelector('.nxc-empty');
      if (empty) this.listEl.removeChild(empty);
      if (this.listEl.firstChild) {
        this.listEl.insertBefore(node, this.listEl.firstChild);
      } else {
        this.listEl.appendChild(node);
      }
      this.total += 1;
      this.loaded += 1;
    } else {
      var box = this.replyBoxes[parentId];
      if (box) box.appendChild(this._renderReply(data));
      this.total += 1;
    }
    this._updateCount();
  };

  CommentWidget.prototype._updateCount = function () {
    this.countEl.textContent = this.total + ' ' + this.labels.title;
  };

  // ---- 拉取 ---------------------------------------------------------------

  CommentWidget.prototype._fetchPage = function (page, isFirst) {
    var self = this;
    var L = this.labels;

    if (isFirst) {
      this.listEl.textContent = '';
      this.listEl.appendChild(el('div', 'nxc-loading', L.loading));
    } else {
      this.loadMoreBtn.disabled = true;
      this.loadMoreBtn.textContent = L.loading;
    }

    var url =
      this.apiBase +
      '?path=' +
      encodeURIComponent(this.path) +
      '&page=' +
      page +
      '&limit=' +
      this.pageSize;

    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (self.destroyed) return;
        if (!json || !json.success) throw new Error('bad response');
        if (isFirst) {
          self.listEl.textContent = '';
          self.loaded = 0;
        }
        self.page = page;
        self.total = typeof json.total === 'number' ? json.total : 0;
        var rows = json.data || [];
        self.loaded += rows.length;

        for (var i = 0; i < rows.length; i++) {
          self.listEl.appendChild(self._renderItem(rows[i]));
        }
        if (isFirst && rows.length === 0) {
          self.listEl.appendChild(el('div', self._c('empty', 'nxc-empty'), L.empty));
        }
        self._updateCount();
        self._syncLoadMore(json.has_more);
      })
      .catch(function () {
        if (self.destroyed) return;
        if (isFirst) {
          self.listEl.textContent = '';
          self.listEl.appendChild(self._renderListError());
        } else {
          self.loadMoreBtn.disabled = false;
          self.loadMoreBtn.textContent = L.loadMore;
        }
      });
  };

  /**
   * 是否还有下一页：一律以后端返回的 has_more 为准。
   * 不能用 page*limit 与 total 比 —— total 是「含回复」的总数，
   * 而分页只针对顶层评论，两者量纲不同会算错。
   */
  CommentWidget.prototype._syncLoadMore = function (hasMore) {
    this.loadMoreBtn.disabled = false;
    this.loadMoreBtn.textContent = this.labels.loadMore;
    this.loadMoreBtn.style.display = hasMore === true ? '' : 'none';
  };

  CommentWidget.prototype._renderListError = function () {
    var self = this;
    var box = el('div', this._c('listError', 'nxc-list-error'));
    box.appendChild(el('span', null, this.labels.loadError));
    var retry = el('button', 'nxc-retry', this.labels.retry);
    retry.type = 'button';
    this._on(retry, 'click', function () {
      self._fetchPage(1, true);
    });
    box.appendChild(retry);
    return box;
  };

  // ---- 渲染（XSS 铁律：全部 textContent / createElement） -------------------

  CommentWidget.prototype._avatarUrl = function (hash) {
    return hash
      ? this.avatarBase + encodeURIComponent(hash) + '?d=mm&s=80'
      : this.avatarBase + '?d=mm';
  };

  /**
   * 作者名节点：有合法 http(s) 网址渲染成 <a>，否则纯文本。
   * href 校验在 safeHttpUrl 内做（防 javascript: XSS）。
   */
  CommentWidget.prototype._renderAuthor = function (name, website) {
    var safe = safeHttpUrl(website);
    var text = name || '';
    if (!safe) return el('span', this._c('author', 'nxc-author'), text);
    var a = el('a', this._c('author', 'nxc-author nxc-author-link'), text);
    a.href = safe; // 已白名单校验：仅 http:// https://
    a.rel = 'nofollow noopener';
    a.target = '_blank';
    return a;
  };

  /** 顶层评论项（含 replies 区 + 回复按钮） */
  CommentWidget.prototype._renderItem = function (c) {
    var self = this;
    var item = el('div', this._c('item', 'nxc-item'));
    item.setAttribute('data-nxc-id', String(c.id));

    var avatar = el('img', this._c('avatar', 'nxc-avatar'));
    avatar.src = this._avatarUrl(c.email_hash);
    avatar.alt = '';
    avatar.loading = 'lazy';
    item.appendChild(avatar);

    var main = el('div', this._c('itemMain', 'nxc-item-main'));

    var head = el('div', this._c('itemHead', 'nxc-item-head'));
    head.appendChild(this._renderAuthor(c.author_name, c.author_website));
    head.appendChild(
      el('span', this._c('time', 'nxc-time'), relativeTime(c.created_at, this.labels))
    );
    main.appendChild(head);

    // 换行交给 CSS white-space: pre-wrap，不做 \n -> <br> 转换
    main.appendChild(el('div', this._c('content', 'nxc-content'), c.content || ''));

    var replyBtn = el('button', this._c('replyBtn', 'nxc-reply-btn'), this.labels.reply);
    replyBtn.type = 'button';
    main.appendChild(replyBtn);

    // 内联回复表单挂载点
    var formSlot = el('div', 'nxc-reply-slot');
    main.appendChild(formSlot);

    var repliesBox = el('div', this._c('replies', 'nxc-replies'));
    var replies = c.replies || [];
    for (var i = 0; i < replies.length; i++) {
      repliesBox.appendChild(this._renderReply(replies[i]));
    }
    main.appendChild(repliesBox);
    this.replyBoxes[c.id] = repliesBox;

    this._on(replyBtn, 'click', function () {
      self._toggleReplyForm(c.id, formSlot);
    });

    item.appendChild(main);
    return item;
  };

  /** 二级回复项（parent_id 一律是顶层 id，后端已把楼中楼拍平） */
  CommentWidget.prototype._renderReply = function (r) {
    var node = el('div', this._c('replyItem', 'nxc-reply-item'));

    var avatar = el('img', this._c('avatar', 'nxc-avatar nxc-avatar-sm'));
    avatar.src = this._avatarUrl(r.email_hash);
    avatar.alt = '';
    avatar.loading = 'lazy';
    node.appendChild(avatar);

    var main = el('div', this._c('itemMain', 'nxc-item-main'));

    var head = el('div', this._c('itemHead', 'nxc-item-head'));
    head.appendChild(this._renderAuthor(r.author_name, r.author_website));
    if (r.reply_to_name) {
      // '@' 与用户名分离：用户名走 textContent，@ 是我们自己的字面量
      var at = el('span', this._c('replyTo', 'nxc-reply-to'));
      at.appendChild(document.createTextNode('@'));
      at.appendChild(document.createTextNode(String(r.reply_to_name)));
      head.appendChild(at);
    }
    head.appendChild(
      el('span', this._c('time', 'nxc-time'), relativeTime(r.created_at, this.labels))
    );
    main.appendChild(head);
    main.appendChild(el('div', this._c('content', 'nxc-content'), r.content || ''));

    node.appendChild(main);
    return node;
  };

  /** 同时只允许一个内联回复表单展开 */
  CommentWidget.prototype._toggleReplyForm = function (parentId, slot) {
    var self = this;

    if (this.activeReplyForm) {
      var prev = this.activeReplyForm;
      prev.slot.removeChild(prev.form.wrap);
      this.activeReplyForm = null;
      if (prev.slot === slot) return; // 点同一个 = 收起
    }

    var form = this._buildForm(
      parentId,
      function (data, pending) {
        self._onPosted(data, pending, parentId);
        if (!pending) self._closeReplyForm();
      },
      function () {
        self._closeReplyForm();
      }
    );
    form.wrap.className += ' nxc-form-reply';
    slot.appendChild(form.wrap);
    this.activeReplyForm = { form: form, slot: slot };
    form.textarea.focus();
  };

  CommentWidget.prototype._closeReplyForm = function () {
    if (!this.activeReplyForm) return;
    var a = this.activeReplyForm;
    if (a.form.wrap.parentNode === a.slot) a.slot.removeChild(a.form.wrap);
    this.activeReplyForm = null;
  };

  // ---- 公开方法 -----------------------------------------------------------

  /** 重新拉取第一页 */
  CommentWidget.prototype.reload = function () {
    if (this.destroyed) return;
    this.replyBoxes = {};
    this._closeReplyForm();
    this._fetchPage(1, true);
  };

  /** 卸载：解绑事件 + 清空 DOM（React 卸载时必调） */
  CommentWidget.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    var ls = this._listeners || [];
    for (var i = 0; i < ls.length; i++) {
      ls[i][0].removeEventListener(ls[i][1], ls[i][2]);
    }
    this._listeners = [];
    if (this.root && this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }
    this.replyBoxes = {};
    this.activeReplyForm = null;
  };

  // ---------------------------------------------------------------------------
  // 对外命名空间
  // ---------------------------------------------------------------------------

  var NexusComments = {
    /**
     * 初始化一个评论组件
     * @returns {CommentWidget} 含 reload() / destroy()
     */
    init: function (options) {
      return new CommentWidget(options);
    },

    /**
     * 批量查询多个页面的评论数（用于文章列表页显示 "N 条评论"）
     * @param {string} apiBase
     * @param {string[]} paths
     * @returns {Promise<Object>} { "/a/": 3, ... }
     */
    counts: function (apiBase, paths) {
      var base = String(apiBase || '').replace(/\/+$/, '');
      return fetch(base + '/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ paths: (paths || []).map(normalizePath) })
      })
        .then(function (res) {
          return res.json();
        })
        .then(function (json) {
          return json && json.success ? json.data || {} : {};
        })
        .catch(function () {
          return {};
        });
    },

    /** 暴露给需要自定义封装的场景 */
    Widget: CommentWidget,
    normalizePath: normalizePath
  };

  global.NexusComments = NexusComments;

  // UMD guard：让 React / bundler 环境可以 import
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NexusComments;
  }
})(typeof window !== 'undefined' ? window : this);
