// Content script: auto-scroll, highlight clickables, report internal links & DOM
// Enhanced with cookie consent, search, and form interactions
(function () {
  if (window.CAST_CONTENT_LOADED) return;
  window.CAST_CONTENT_LOADED = true;

  const origin = location.origin;

  function isClickable(el) {
    try {
      const style = getComputedStyle(el);
      return (
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        el.onclick ||
        el.getAttribute("role") === "button" ||
        style.cursor === "pointer"
      );
    } catch (e) {
      return false;
    }
  }

  function highlight(el) {
    el.classList.add("cast-highlight-clickable");
  }

  // Wait for element to be visible and interactable (reduced timeout)
  function waitForElement(selector, timeout = 2000) {
    return new Promise((resolve) => {
      const element = document.querySelector(selector);
      if (element && element.offsetParent !== null) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el && el.offsetParent !== null) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // Handle cookie consent banners
  async function handleCookieConsent() {
    const acceptSelectors = [
      'button[id*="accept"]',
      'button[class*="accept"]',
      'button:contains("Accept")',
      'button:contains("Accept All")',
      'button:contains("Accept Cookies")',
      '[id*="cookie"] button:contains("Accept")',
      '[class*="cookie"] button:contains("Accept")',
      '[id*="consent"] button:contains("Accept")',
      '[class*="consent"] button:contains("Accept")',
      'button[aria-label*="Accept" i]',
      '[role="button"][aria-label*="Accept" i]'
    ];

    // Try text-based matching for buttons
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of allButtons) {
      const text = (btn.textContent || btn.innerText || '').toLowerCase();
      if (text.includes('accept') && (text.includes('cookie') || text.includes('all') || text.length < 30)) {
        try {
          btn.click();
          await new Promise(resolve => setTimeout(resolve, 150));
          return true;
        } catch (e) {}
      }
    }

    // Try selectors
    for (const selector of acceptSelectors) {
      try {
        const btn = await waitForElement(selector, 1500);
        if (btn) {
          btn.click();
          await new Promise(resolve => setTimeout(resolve, 150));
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  // Interact with search boxes
  async function interactWithSearch() {
    // Skip if already on a search results page
    const currentPath = location.pathname.toLowerCase();
    const currentQuery = location.search.toLowerCase();
    const isSearchResultsPage = currentPath.includes('/search') || 
                                currentPath.includes('/results') || 
                                currentPath.includes('/find') ||
                                currentQuery.includes('?s=') || 
                                currentQuery.includes('?q=') || 
                                currentQuery.includes('?query=') || 
                                currentQuery.includes('?search=') ||
                                document.title.toLowerCase().includes('search results');
    
    if (isSearchResultsPage) {
      console.log('CAST: Skipping search interaction on search results page.');
      return false;
    }

    const storageKey = 'CAST_searchedInputs';
    const result = await new Promise(resolve => {
      chrome.storage.local.get([storageKey], resolve);
    });
    const searchedInputs = new Set(result[storageKey] || []);

    const searchSelectors = [
      'input[type="search"]',
      'input[name*="search" i]',
      'input[id*="search" i]',
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]'
    ];

    for (const selector of searchSelectors) {
      try {
        const input = await waitForElement(selector, 2000);
        if (input && input.offsetParent !== null) {
          const inputId = input.id || input.name || input.placeholder || `search_${location.pathname}`;
          if (searchedInputs.has(inputId)) {
            console.log(`CAST: Skipping already searched input: ${inputId}`);
            continue;
          }

          input.focus();
          input.value = 'Test'; // Changed to "Test" as requested
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          
          // Try to find and click search button
          const form = input.closest('form');
          if (form) {
            // Look for submit button
            let submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
            
            // If not found, search all buttons in form by text content
            if (!submitBtn) {
              const allButtons = form.querySelectorAll('button, [role="button"], input[type="button"]');
              for (const btn of allButtons) {
                const text = (btn.textContent || btn.innerText || btn.value || '').toLowerCase();
                if (text.includes('search') || text.includes('find') || text.includes('go')) {
                  submitBtn = btn;
                  break;
                }
              }
            }
            
            // Also check for icon buttons (search icon)
            if (!submitBtn) {
              const iconButtons = form.querySelectorAll('button[aria-label*="search" i], button svg, button[class*="search"]');
              if (iconButtons.length > 0) {
                submitBtn = iconButtons[0];
              }
            }
            
            if (submitBtn) {
              searchedInputs.add(inputId);
              chrome.storage.local.set({ [storageKey]: Array.from(searchedInputs) });
              await new Promise(resolve => setTimeout(resolve, 200));
              submitBtn.click();
              await new Promise(resolve => setTimeout(resolve, 300));
              return true;
            }
          }
          
          // Try Enter key
          searchedInputs.add(inputId);
          chrome.storage.local.set({ [storageKey]: Array.from(searchedInputs) });
          await new Promise(resolve => setTimeout(resolve, 100));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 300));
          return true;
        }
      } catch (e) {
        console.error('CAST search interaction error:', e);
      }
    }

    return false;
  }

  // Interact with subscription/email forms (only once per form per crawl session)
  async function interactWithSubscriptionForms() {
    // Get list of already-submitted forms from storage
    const storageKey = 'CAST_submittedForms';
    const result = await new Promise(resolve => {
      chrome.storage.local.get([storageKey], resolve);
    });
    const submittedForms = new Set(result[storageKey] || []);

    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[aria-label*="email" i]'
    ];

    for (const selector of emailSelectors) {
      try {
        const input = await waitForElement(selector, 2000);
        if (input && input.offsetParent !== null) {
          // Check if it's in a subscription/newsletter context
          const form = input.closest('form');
          const container = input.closest('[class*="newsletter"], [class*="subscribe"], [class*="signup"], [id*="newsletter"], [id*="subscribe"], [id*="signup"]');
          
          if (form || container) {
            // Create unique identifier for this form
            let formId = null;
            if (form) {
              formId = form.action || form.id || form.name || 
                       (form.querySelector('input[type="email"]')?.id || form.querySelector('input[type="email"]')?.name) ||
                       form.getAttribute('data-form-id');
            }
            if (!formId && container) {
              formId = container.id || container.className || 
                       (container.querySelector('input[type="email"]')?.id || container.querySelector('input[type="email"]')?.name);
            }
            // Fallback: use email input identifier
            if (!formId) {
              formId = input.id || input.name || input.placeholder || 'email_' + location.pathname;
            }
            
            // Check if we've already submitted to this form
            if (submittedForms.has(formId)) {
              continue; // Skip this form, already submitted
            }
            
            input.focus();
            input.value = 'analytics@applydigital.com';
            
            // Trigger all input events to ensure form validation passes
            input.dispatchEvent(new Event('focus', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            input.focus(); // Focus again after blur
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Try to find and click submit button - improved detection
            let submitBtn = null;
            if (form) {
              // First try standard submit selectors
              submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
              
              // If not found, search all buttons in form by text content
              if (!submitBtn) {
                const allButtons = form.querySelectorAll('button, [role="button"], input[type="button"]');
                for (const btn of allButtons) {
                  const text = (btn.textContent || btn.innerText || btn.value || '').toLowerCase();
                  if (text.includes('subscribe') || text.includes('sign up') || text.includes('submit') || 
                      text.includes('join') || text.includes('send') || text.includes('get started') ||
                      text.includes('submit email') || text.includes('sign me up')) {
                    submitBtn = btn;
                    break;
                  }
                }
              }
              
              // Also check parent container for buttons
              if (!submitBtn && container) {
                const containerButtons = container.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
                for (const btn of containerButtons) {
                  const text = (btn.textContent || btn.innerText || btn.value || '').toLowerCase();
                  if (text.includes('subscribe') || text.includes('sign up') || text.includes('submit') || 
                      text.includes('join') || text.includes('send') || text.includes('get started') ||
                      text.includes('submit email') || text.includes('sign me up')) {
                    submitBtn = btn;
                    break;
                  }
                }
              }
              
              // Also check for icon buttons (arrow, checkmark, etc.)
              if (!submitBtn) {
                const iconButtons = form.querySelectorAll('button svg, button[aria-label*="submit" i], button[class*="submit"]');
                if (iconButtons.length > 0) {
                  submitBtn = iconButtons[0].closest('button') || iconButtons[0];
                }
              }
              
              if (submitBtn) {
                // Mark this form as submitted before clicking
                submittedForms.add(formId);
                chrome.storage.local.set({ [storageKey]: Array.from(submittedForms) });
                
                // Scroll button into view
                submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Click with multiple event types for better compatibility
                submitBtn.focus();
                submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                submitBtn.click();
                submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                
                await new Promise(resolve => setTimeout(resolve, 500)); // Longer wait for form submission
                console.log('CAST: Submitted subscription form with analytics@applydigital.com');
                return true;
              }
            }
            
            // Try form.submit() as fallback
            if (form && form.submit) {
              submittedForms.add(formId);
              chrome.storage.local.set({ [storageKey]: Array.from(submittedForms) });
              await new Promise(resolve => setTimeout(resolve, 100));
              form.submit();
              await new Promise(resolve => setTimeout(resolve, 500));
              console.log('CAST: Submitted subscription form via form.submit()');
              return true;
            }
            
            // Try Enter key - mark as submitted even if using Enter key
            submittedForms.add(formId);
            chrome.storage.local.set({ [storageKey]: Array.from(submittedForms) });
            
            await new Promise(resolve => setTimeout(resolve, 100));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 500));
            console.log('CAST: Submitted subscription form via Enter key');
            return true;
          }
        }
      } catch (e) {}
    }

    return false;
  }

  // Click ALL clickable elements to fire analytics
  async function triggerAnalyticsClicks() {
    // Get all clickable elements
    const all = Array.from(document.querySelectorAll("a, button, [role='button'], [onclick], [data-click], [class*='click'], [class*='button']"));
    const clickable = all.filter(el => {
      try {
        // Check if element is visible and interactable
        if (el.offsetParent === null) return false;
        
        // Skip dangerous elements
        const tag = el.tagName.toLowerCase();
        const type = el.type?.toLowerCase();
        
        // Skip form submits (already handled separately)
        if (type === 'submit') return false;
        
        // Skip elements that would navigate away
        if (tag === 'a') {
          const href = el.href;
          if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
            // Only skip external links, allow internal ones
            try {
              const url = new URL(href);
              if (url.origin !== origin) return false; // Skip external links
            } catch (e) {
              // Invalid URL, skip it
              return false;
            }
          }
        }
        
        // Check if it's actually clickable
        const style = getComputedStyle(el);
        if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        
        // Skip elements that are too small (likely icons/spacers)
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        
        return isClickable(el);
      } catch (e) {
        return false;
      }
    });

    console.log(`CAST: Found ${clickable.length} clickable elements, clicking all...`);
    
    // Limit to prevent too many clicks (safety measure)
    const maxClicks = 100;
    const elementsToClick = clickable.slice(0, maxClicks);
    
    // Click each element with a small delay
    for (let i = 0; i < elementsToClick.length; i++) {
      const el = elementsToClick[i];
      try {
        // Check if page is still the same (prevent navigation issues)
        const currentUrl = location.href;
        
        // Scroll element into view first (but don't wait too long)
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 30));
        
        // Check URL again before clicking
        if (location.href !== currentUrl) {
          console.log('CAST: Page navigated, stopping click sequence');
          break;
        }
        
        // Prevent actual navigation for links – we only want analytics events
        let preventedNavHandler = null;
        if (el.tagName.toLowerCase() === 'a') {
          preventedNavHandler = (event) => {
            event.preventDefault();
            event.stopPropagation();
          };
          el.addEventListener('click', preventedNavHandler, { capture: true, once: true });
        }
        
        // Trigger mouse events for better analytics coverage (before click)
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        
        // Click the element
        el.click();
        
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Check if page navigated after click
        if (location.href !== currentUrl) {
          console.log('CAST: Page navigated after click, stopping click sequence');
          break;
        }
      } catch (e) {
        console.warn('CAST: Error clicking element:', e);
        // Continue with next element
      }
    }
    
    console.log(`CAST: Finished clicking ${elementsToClick.length} elements`);
  }

  function scanPage(depth) {
    // Find ALL clickable elements more comprehensively
    const all = Array.from(
      document.querySelectorAll("a, button, [role='button'], [onclick], [data-click], [class*='click'], [class*='button'], input[type='button'], input[type='submit']")
    );
    
    // Also check for elements with cursor pointer style
    const allElements = Array.from(document.querySelectorAll("*"));
    const pointerElements = allElements.filter(el => {
      try {
        const style = getComputedStyle(el);
        return style.cursor === 'pointer' && el.offsetParent !== null;
      } catch (e) {
        return false;
      }
    });
    
    // Combine and deduplicate
    const allClickable = [...new Set([...all, ...pointerElements])];
    const clickable = allClickable.filter(el => {
      try {
        // Basic visibility check
        if (el.offsetParent === null) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return isClickable(el) || style.cursor === 'pointer';
      } catch (e) {
        return false;
      }
    });

    const internalLinks = new Set();

    // Highlight ALL clickable elements
    clickable.forEach((el) => {
      highlight(el);
      // Extract links from various sources
      let href = el.href;
      if (!href && el.tagName === 'A') {
        href = el.getAttribute('href');
      }
      if (!href && el.onclick) {
        // Try to extract URL from onclick handler
        const onclickStr = el.getAttribute('onclick') || '';
        const urlMatch = onclickStr.match(/['"](https?:\/\/[^'"]+)['"]/);
        if (urlMatch) href = urlMatch[1];
      }
      if (href) {
        try {
          const u = new URL(href, location.origin);
          if (u.origin === origin) internalLinks.add(u.href);
        } catch (e) {}
      }
    });

    chrome.runtime.sendMessage({
      type: "page-scanned",
      url: location.href,
      depth,
      dom: document.documentElement.outerHTML.slice(0, 20000),
      clicks: clickable.length,
      internalLinks: Array.from(internalLinks)
    });
  }

  function autoScroll() {
    return new Promise((resolve) => {
      const distance = Math.floor(window.innerHeight * 0.8) || 400;
      let totalHeight = 0;
      let lastScrollTop = -1;
      let steps = 0;
      const maxSteps = 20;

      const timer = setInterval(() => {
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        const docHeight = document.documentElement.scrollHeight;
        const viewHeight = window.innerHeight;

        if (
          scrollTop === lastScrollTop ||
          steps >= maxSteps ||
          totalHeight + viewHeight >= docHeight
        ) {
          clearInterval(timer);
          setTimeout(resolve, 100); // Reduced to 100ms at bottom
          return;
        }

        window.scrollBy(0, distance);
        totalHeight += distance;
        lastScrollTop = scrollTop;
        steps += 1;
      }, 150); // Faster scroll interval (150ms instead of 200ms)
    });
  }

  async function interactAndScan(depth) {
    let scannedOnce = false;
    try {
      // Wait for page to be ready (minimal delay)
      await new Promise(resolve => setTimeout(resolve, 200));

      // Run interactions in parallel where possible for speed
      const interactions = Promise.allSettled([
        handleCookieConsent(),
        interactWithSearch(),
        interactWithSubscriptionForms()
      ]);
      
      // Wait briefly for interactions to complete
      await interactions;
      await new Promise(resolve => setTimeout(resolve, 200));

      // Auto-scroll (this needs to be sequential)
      await autoScroll();
      await new Promise(resolve => setTimeout(resolve, 200));

      // Scan before clicking so the background queue receives every link
      scanPage(depth);
      scannedOnce = true;
      await new Promise(resolve => setTimeout(resolve, 200));

      // Click ALL clickable elements to trigger analytics
      await triggerAnalyticsClicks();
      await new Promise(resolve => setTimeout(resolve, 500)); // Longer wait after clicking all elements
    } catch (e) {
      console.error('CAST interaction error:', e);
      // Still scan if we never sent the page data
      if (!scannedOnce) {
        scanPage(depth);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "scan-page") {
      console.log('CAST: Received scan-page message, depth:', msg.depth || 0);
      interactAndScan(msg.depth || 0);
      sendResponse({ success: true }); // Acknowledge receipt
      return true; // Keep channel open for async response
    }
  });
  
  // Log that content script is loaded
  console.log('CAST: Content script loaded and ready');
})();
