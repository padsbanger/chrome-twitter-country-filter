/* Twitter Country Filter — X DOM selectors (isolated world, classic script).
 * All X DOM selectors live here so selector drift is a one-file fix.
 */
(() => {
  'use strict';
  if (window.TCFSEL) return;

  const SEL_TWEET = 'article[data-testid="tweet"]';
  const SEL_NAME_BLOCKS = ['[data-testid="User-Name"]', '[data-testid="UserName"]'];
  const SEL_QUOTE_CONTAINER = 'div[role="link"]';
  const RE_PROFILE_HREF = /^\/([A-Za-z0-9_]{1,50})$/;

  function firstNameBlock(rootEl) {
    for (let i = 0; i < SEL_NAME_BLOCKS.length; i++) {
      const el = rootEl.querySelector(SEL_NAME_BLOCKS[i]);
      if (el) return el;
    }
    return null;
  }

  /** First name block in rootEl, then its first a[href] matching RE_PROFILE_HREF. */
  function extractAuthor(rootEl) {
    try {
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return null;
      const nameBlockEl = firstNameBlock(rootEl);
      if (!nameBlockEl) return null;
      const links = nameBlockEl.querySelectorAll('a[href]');
      for (let i = 0; i < links.length; i++) {
        const href = links[i].getAttribute('href');
        if (!href) continue;
        const m = RE_PROFILE_HREF.exec(href);
        if (m) return {screen_name: m[1], nameBlockEl: nameBlockEl};
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Among div[role="link"] descendants, first containing a name block;
   *  screen_name is the last @token in its text (quote authors are plain text). */
  function extractQuotedAuthor(article) {
    try {
      if (!article || typeof article.querySelectorAll !== 'function') return null;
      const containers = article.querySelectorAll(SEL_QUOTE_CONTAINER);
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        const nameBlockEl = firstNameBlock(container);
        if (!nameBlockEl) continue;
        const text = container.textContent || '';
        const matches = text.match(/@([A-Za-z0-9_]{1,50})/g);
        if (!matches || !matches.length) continue;
        const m = /@([A-Za-z0-9_]{1,50})$/.exec(matches[matches.length - 1]);
        if (m) return {screen_name: m[1], nameBlockEl: nameBlockEl};
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  window.TCFSEL = {
    SEL_TWEET: SEL_TWEET,
    SEL_NAME_BLOCKS: SEL_NAME_BLOCKS,
    SEL_QUOTE_CONTAINER: SEL_QUOTE_CONTAINER,
    RE_PROFILE_HREF: RE_PROFILE_HREF,
    extractAuthor: extractAuthor,
    extractQuotedAuthor: extractQuotedAuthor
  };
})();
