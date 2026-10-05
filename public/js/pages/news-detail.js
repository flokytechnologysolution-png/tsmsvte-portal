/**
 * public/js/pages/news-detail.js — one article.  The friendly URL is
 * /news/:slug (server rewrites it here); /news-detail.html?id=N also works.
 */
(function () {
  'use strict';

  function slugFromPath() {
    const m = window.location.pathname.match(/^\/news\/([^\/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  App.ready(function () {
    const host = document.getElementById('article');
    const key = slugFromPath() || App.param('id') || App.param('slug');
    if (!key) {
      host.innerHTML = App.emptyState('Article not found', 'Go back to the news list and pick a story.');
      return;
    }
    App.api('/api/news/' + encodeURIComponent(key)).then(function (data) {
      const a = data.article;
      document.title = a.title + ' — Ministry news';
      host.innerHTML =
        (a.cover_image ? '<div class="article-cover"><img src="' + App.esc(a.cover_image) + '" alt=""></div>' : '') +
        '<span class="badge">' + App.esc(a.category || 'News') + '</span>' +
        '<h1 class="mt-1">' + App.esc(a.title) + '</h1>' +
        '<div class="article-meta">' +
          '<span>' + App.esc(App.fmtDate(a.published_at || a.created_at, true)) + '</span>' +
          (a.status === 'draft' ? '<span class="badge warn">draft — visible to editors only</span>' : '') +
        '</div>' +
        (a.summary ? '<p class="muted"><strong>' + App.esc(a.summary) + '</strong></p>' : '') +
        '<div class="article-body">' + App.esc(a.body) + '</div>' +
        '<hr class="divider">' +
        '<a class="btn btn-outline btn-sm" href="/news.html">&larr; Back to all news</a>';
    }).catch(function (err) {
      host.innerHTML = App.emptyState('Article not found', err.status === 404
        ? 'This story may have been unpublished or the link is wrong.'
        : err.message);
    });
  });
})();
