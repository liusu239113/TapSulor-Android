/* ========== TapSulor Theme Controller for TapTap Developer Backend ========== */
/* Handles SPA route changes and ensures theme persists across navigation */
(function() {
  'use strict';

  if (window.__tsThemeInstalled) return;
  window.__tsThemeInstalled = true;

  const THEME_CSS_ID = '__taptap_theme_css__';
  const OBSERVER_TARGET = document.body;

  // Track SPA URL changes
  let lastUrl = location.href;

  function reapplyTheme() {
    // Ensure the CSS style element is present (SPA navigations may remove/recreate head)
    if (!document.getElementById(THEME_CSS_ID)) {
      var style = document.createElement('style');
      style.id = THEME_CSS_ID;
      // The CSS was injected as inline text by the native side; if missing, we can't restore
      // but we know the native side will call injectTheme on each page finish
    }

    // Force override any inline white backgrounds that React might set after render
    fixInlineWhiteBackgrounds();
  }

  function fixInlineWhiteBackgrounds() {
    // Walk elements with white/light inline backgrounds and fix them
    var elements = document.querySelectorAll('[style*="background"], [style*="background-color"]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var bg = el.style.backgroundColor || el.style.background;
      if (!bg) continue;
      // Check for white/near-white backgrounds
      if (isWhiteish(bg)) {
        // Only override if the element is a container/card/panel, not an image or colored accent
        var tag = el.tagName.toLowerCase();
        if (tag === 'div' || tag === 'section' || tag === 'header' || tag === 'nav' ||
            tag === 'aside' || tag === 'main' || tag === 'article' || tag === 'footer' ||
            tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr' ||
            tag === 'td' || tag === 'th' || tag === 'ul' || tag === 'ol' || tag === 'li' ||
            tag === 'form' || tag === 'span' || tag === 'p') {
          // Check if this element already has our theme class
          if (!el.classList.contains('__ts_themed__')) {
            el.classList.add('__ts_themed__');
            el.style.setProperty('background-color', 'var(--ts-bg-card)', 'important');
            el.style.setProperty('color', 'var(--ts-text-primary)', 'important');
          }
        }
      }
    }
  }

  function isWhiteish(bg) {
    if (!bg) return false;
    bg = bg.toLowerCase().trim();
    if (bg === 'white' || bg === '#fff' || bg === '#ffffff' || bg === '#FFF' || bg === '#FFFFFF') {
      return true;
    }
    // Match rgb(255,255,255) or rgba(255,255,255, ...)
    var m = bg.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (m) {
      var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      // If all channels > 240, treat as white-ish
      if (r >= 240 && g >= 240 && b >= 240) return true;
      // Very light gray (> 245)
      if (r >= 245 && g >= 245 && b >= 245) return true;
    }
    // Match hex shorthand
    m = bg.match(/^#([0-9a-f]{3})$/i);
    if (m) {
      var hex = m[1];
      var rh = parseInt(hex[0] + hex[0], 16);
      var gh = parseInt(hex[1] + hex[1], 16);
      var bh = parseInt(hex[2] + hex[2], 16);
      if (rh >= 240 && gh >= 240 && bh >= 240) return true;
    }
    return false;
  }

  // MutationObserver to catch dynamically added content
  var observer = new MutationObserver(function(mutations) {
    var needsFix = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0) {
        needsFix = true;
        break;
      }
    }
    if (needsFix) {
      // Debounce
      if (window.__tsFixTimer) clearTimeout(window.__tsFixTimer);
      window.__tsFixTimer = setTimeout(fixInlineWhiteBackgrounds, 150);
    }
  });

  observer.observe(OBSERVER_TARGET, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });

  // Monitor SPA route changes via history API and hash changes
  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;

  history.pushState = function() {
    originalPushState.apply(this, arguments);
    setTimeout(reapplyTheme, 300);
    setTimeout(reapplyTheme, 1000);
    setTimeout(reapplyTheme, 2000);
  };

  history.replaceState = function() {
    originalReplaceState.apply(this, arguments);
    setTimeout(reapplyTheme, 300);
    setTimeout(reapplyTheme, 1000);
  };

  window.addEventListener('popstate', function() {
    setTimeout(reapplyTheme, 300);
    setTimeout(reapplyTheme, 1000);
  });

  // Also poll URL changes (some SPAs use other mechanisms)
  setInterval(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reapplyTheme();
    }
  }, 1000);

  // Initial application
  setTimeout(fixInlineWhiteBackgrounds, 500);
  setTimeout(fixInlineWhiteBackgrounds, 1500);
  setTimeout(fixInlineWhiteBackgrounds, 3000);

  console.log('[TapSulor Theme] Dark cyan theme controller loaded');
})();
