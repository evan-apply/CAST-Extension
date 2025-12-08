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
        
        // Click the element - use click() method if available, otherwise dispatch click event
        if (typeof el.click === 'function') {
          el.click();
        } else {
          // Fallback: dispatch a click event for elements without click() method
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        
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

  // Highlight element(s) with overlay
  function highlightElement(selector, label) {
    try {
      // Skip invalid/global selectors
      if (!selector || selector === 'window' || selector === 'document') {
        console.warn(`CAST: Skipping highlight for invalid selector: ${selector}`);
        return;
      }

      let elements;
      try {
        elements = document.querySelectorAll(selector);
      } catch (err) {
        console.warn(`CAST: Invalid selector, cannot query: ${selector}`, err);
        return;
      }

      // Use querySelectorAll to handle groups of elements
      if (elements.length === 0) {
        console.warn(`CAST: Element not found for selector: ${selector}`);
        return;
      }

      // Only scroll to the first element if highlighting a single selector
      if (label !== "batch" && elements.length > 0) {
          elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      elements.forEach(el => {
          const rect = el.getBoundingClientRect();
          
          // Skip non-visible elements
          if (rect.width === 0 || rect.height === 0) return;

          const overlay = document.createElement('div');
          overlay.className = 'cast-strategy-overlay';
          overlay.style.position = 'absolute';
          overlay.style.top = `${rect.top + window.scrollY}px`;
          overlay.style.left = `${rect.left + window.scrollX}px`;
          overlay.style.width = `${rect.width}px`;
          overlay.style.height = `${rect.height}px`;
          overlay.style.backgroundColor = 'rgba(52, 152, 219, 0.2)'; // Lighter Blue overlay
          overlay.style.border = '2px solid #3498db';
          overlay.style.zIndex = '10000';
          overlay.style.pointerEvents = 'none'; // Allow clicking through
          overlay.style.boxSizing = 'border-box';
          
          // Add label (only for the first element if it's a large group, or maybe all?)
          // Let's add to all for clarity, but maybe small
          if (label && label !== "batch") {
              const labelDiv = document.createElement('div');
              labelDiv.textContent = label;
              labelDiv.style.position = 'absolute';
              labelDiv.style.top = '-20px'; // Slightly closer
              labelDiv.style.left = '0';
              labelDiv.style.backgroundColor = '#3498db';
              labelDiv.style.color = 'white';
              labelDiv.style.padding = '1px 4px';
              labelDiv.style.fontSize = '10px';
              labelDiv.style.borderRadius = '3px';
              labelDiv.style.whiteSpace = 'nowrap';
              labelDiv.style.zIndex = '10001';
              overlay.appendChild(labelDiv);
          }
          
          document.body.appendChild(overlay);
      });
      
    } catch (e) {
      console.error('CAST: Error highlighting element:', e);
    }
  }
  
  function highlightBatch(items) {
      // Clear existing
      document.querySelectorAll('.cast-strategy-overlay').forEach(el => el.remove());
      
      // Highlight all
      items.forEach(item => {
          highlightElement(item.selector, item.label);
      });
  }

  // Generate simplified DOM for AI analysis
  function getSimplifiedDOM() {
    const semanticTags = ['HEADER', 'FOOTER', 'NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE'];
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM'];
    
    const elements = [];
    
    // Helper to detect navigation structure and dropdown menus
    function detectNavigationStructure(node) {
      const navInfo = {
        isNavigation: false,
        location: null, // 'header', 'footer', 'nav', 'dropdown', 'menu'
        parentNav: null,
        hasDropdown: false,
        dropdownItems: []
      };
      
      // Check if node is in header
      const header = node.closest('header, [role="banner"], .header, #header, [class*="header" i]');
      if (header) {
        navInfo.isNavigation = true;
        navInfo.location = 'header';
      }
      
      // Check if node is in footer
      const footer = node.closest('footer, [role="contentinfo"], .footer, #footer, [class*="footer" i]');
      if (footer) {
        navInfo.isNavigation = true;
        navInfo.location = 'footer';
      }
      
      // Check if node is in nav element
      const nav = node.closest('nav, [role="navigation"], .nav, .navigation, [class*="nav" i], [class*="navigation" i]');
      if (nav && !header && !footer) {
        navInfo.isNavigation = true;
        navInfo.location = 'nav';
      }
      
      // Check if node is in a dropdown/menu structure
      const dropdown = node.closest('[role="menu"], [role="menubar"], .dropdown, .menu, [class*="dropdown" i], [class*="menu" i], [aria-expanded="true"], [aria-haspopup="true"]');
      if (dropdown) {
        navInfo.isNavigation = true;
        navInfo.hasDropdown = true;
        if (!navInfo.location) navInfo.location = 'dropdown';
        
        // Find parent nav item that triggers this dropdown
        const parentNav = dropdown.closest('li, .nav-item, [class*="nav-item" i]');
        if (parentNav) {
          const parentLink = parentNav.querySelector('a, button');
          if (parentLink) {
            navInfo.parentNav = {
              text: (parentLink.textContent || '').trim().slice(0, 50),
              href: parentLink.href || null
            };
          }
        }
        
        // Collect dropdown menu items
        const menuItems = dropdown.querySelectorAll('a, button, [role="menuitem"]');
        navInfo.dropdownItems = Array.from(menuItems).slice(0, 20).map(item => ({
          text: (item.textContent || '').trim().slice(0, 50),
          href: item.href || null,
          tag: item.tagName.toLowerCase()
        }));
      }
      
      // Check if node itself is a navigation link/button
      if (node.tagName === 'A' || node.tagName === 'BUTTON') {
        const parent = node.parentElement;
        if (parent && (parent.tagName === 'NAV' || parent.tagName === 'LI' || 
            parent.classList.toString().toLowerCase().includes('nav') ||
            parent.classList.toString().toLowerCase().includes('menu'))) {
          navInfo.isNavigation = true;
          if (!navInfo.location) {
            // Check parent context
            if (header) navInfo.location = 'header';
            else if (footer) navInfo.location = 'footer';
            else navInfo.location = 'nav';
          }
        }
      }
      
      return navInfo;
    }
    
    // Helper to detect form type
    function detectFormType(form) {
      if (!form || form.tagName !== 'FORM') return null;
      
      const formId = (form.id || '').toLowerCase();
      const formClass = (form.className || '').toLowerCase();
      const formAction = (form.action || '').toLowerCase();
      const formName = (form.name || '').toLowerCase();
      
      // Check for email subscription/newsletter forms
      if (formId.includes('newsletter') || formId.includes('subscribe') || formId.includes('signup') ||
          formClass.includes('newsletter') || formClass.includes('subscribe') || formClass.includes('signup') ||
          formName.includes('newsletter') || formName.includes('subscribe') || formName.includes('signup')) {
        return 'email_subscription';
      }
      
      // Check for contact forms
      if (formId.includes('contact') || formClass.includes('contact') || formName.includes('contact') ||
          formAction.includes('contact')) {
        return 'contact';
      }
      
      // Check for email input presence
      const emailInput = form.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
      if (emailInput) {
        // Check if it's likely a subscription form
        const formText = (form.textContent || '').toLowerCase();
        if (formText.includes('subscribe') || formText.includes('newsletter') || formText.includes('sign up') ||
            formText.includes('email updates')) {
          return 'email_subscription';
        }
      }
      
      // Check for contact-related fields
      const hasName = form.querySelector('input[name*="name" i], input[id*="name" i]');
      const hasMessage = form.querySelector('textarea[name*="message" i], textarea[id*="message" i], textarea[name*="comment" i]');
      if (hasName && hasMessage) {
        return 'contact';
      }
      
      return 'form'; // Generic form
    }
    
    function processNode(node, context = 'body') {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      
      const tagName = node.tagName;
      
      // Update context if we enter a semantic section
      let currentContext = context;
      if (semanticTags.includes(tagName)) {
        currentContext = tagName.toLowerCase();
      }
      
      // Special handling for forms - capture form with its type
      if (tagName === 'FORM') {
        const formType = detectFormType(node);
        const formFields = [];
        
        // Capture key form fields
        const inputs = node.querySelectorAll('input, textarea, select');
        inputs.forEach(input => {
          const inputType = input.type || 'text';
          const inputName = input.name || input.id || '';
          const inputPlaceholder = input.placeholder || '';
          formFields.push({
            type: inputType,
            name: inputName,
            placeholder: inputPlaceholder
          });
        });
        
        // Find submit button
        const submitBtn = node.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        const submitText = submitBtn ? (submitBtn.textContent || submitBtn.value || '').trim() : '';
        
        // Generate selector for the form
        let selector = 'form';
        if (node.id) selector += `#${node.id}`;
        else if (node.className && typeof node.className === 'string') {
          const classes = node.className.trim().split(/\s+/).filter(c => c && !c.startsWith('cast-'));
          if (classes.length) selector += `.${classes.slice(0, 2).join('.')}`;
        }
        
        elements.push({
          tag: 'form',
          id: node.id || null,
          class: node.className && typeof node.className === 'string' ? node.className : null,
          text: (node.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
          action: node.action || null,
          formType: formType,
          formFields: formFields.slice(0, 10), // Limit fields
          submitButtonText: submitText,
          context: currentContext,
          path: getCssPath(node)
        });
      }
      
      // Check if it's an element of interest
      if (interactiveTags.includes(tagName) || 
          (semanticTags.includes(tagName)) ||
          node.onclick || 
          node.getAttribute('role') === 'button') {
        
        // Detect navigation structure
        const navInfo = detectNavigationStructure(node);
        
        // For form inputs, still capture them individually (especially email inputs for subscription detection)
        // The form itself is captured separately with formType
            
        // Generate a selector (simplified)
        let selector = tagName.toLowerCase();
        if (node.id) selector += `#${node.id}`;
        else if (node.className && typeof node.className === 'string') {
           // Take first 2 classes
           const classes = node.className.trim().split(/\s+/).filter(c => c && !c.startsWith('cast-'));
           if (classes.length) selector += `.${classes.slice(0, 2).join('.')}`;
        }
        
        // For navigation items, try to create a more specific selector
        if (navInfo.isNavigation && (tagName === 'A' || tagName === 'BUTTON')) {
          // If it's in a list, include list context
          const listItem = node.closest('li');
          if (listItem) {
            const list = listItem.closest('ul, ol, [role="menu"], [role="menubar"]');
            if (list) {
              // Create selector that includes list context
              const listId = list.id;
              const listClass = list.className && typeof list.className === 'string' 
                ? list.className.trim().split(/\s+/).filter(c => c && !c.startsWith('cast-'))[0] 
                : null;
              
              if (listId) {
                selector = `${list.tagName.toLowerCase()}#${listId} ${selector}`;
              } else if (listClass) {
                selector = `${list.tagName.toLowerCase()}.${listClass} ${selector}`;
              }
            }
          }
        }
        
        // Capture text content (truncated)
        let text = '';
        if (tagName === 'INPUT') {
            text = node.placeholder || node.name || node.value || '';
        } else {
            text = (node.innerText || '').slice(0, 50).replace(/\s+/g, ' ').trim();
        }
        
        const elementData = {
          tag: tagName.toLowerCase(),
          id: node.id || null,
          class: node.className && typeof node.className === 'string' ? node.className : null,
          text: text,
          href: node.href || null,
          action: node.action || null, // for forms
          context: currentContext,
          path: getCssPath(node)
        };
        
        // Add navigation information if applicable
        if (navInfo.isNavigation) {
          elementData.navigation = {
            location: navInfo.location,
            hasDropdown: navInfo.hasDropdown,
            parentNav: navInfo.parentNav,
            dropdownItems: navInfo.dropdownItems.length > 0 ? navInfo.dropdownItems : null
          };
        }
        
        elements.push(elementData);
      }
      
      // Special handling: Capture dropdown menu containers even if they're not directly interactive
      // This helps identify dropdown structures
      if (tagName === 'UL' || tagName === 'OL' || tagName === 'DIV') {
        const navInfo = detectNavigationStructure(node);
        if (navInfo.hasDropdown || (navInfo.isNavigation && navInfo.location === 'dropdown')) {
          // Capture the dropdown container
          const dropdownLinks = node.querySelectorAll('a, button, [role="menuitem"]');
          if (dropdownLinks.length > 0) {
            const dropdownItems = Array.from(dropdownLinks).slice(0, 20).map(item => ({
              text: (item.textContent || '').trim().slice(0, 50),
              href: item.href || null,
              tag: item.tagName.toLowerCase()
            }));
            
            let selector = tagName.toLowerCase();
            if (node.id) selector += `#${node.id}`;
            else if (node.className && typeof node.className === 'string') {
              const classes = node.className.trim().split(/\s+/).filter(c => c && !c.startsWith('cast-'));
              if (classes.length) selector += `.${classes.slice(0, 2).join('.')}`;
            }
            
            elements.push({
              tag: 'dropdown_menu',
              id: node.id || null,
              class: node.className && typeof node.className === 'string' ? node.className : null,
              text: `Dropdown menu with ${dropdownItems.length} items`,
              context: currentContext,
              path: getCssPath(node),
              navigation: {
                location: navInfo.location || 'dropdown',
                hasDropdown: true,
                parentNav: navInfo.parentNav,
                dropdownItems: dropdownItems
              }
            });
          }
        }
      }
      
      // Recurse
      for (let i = 0; i < node.children.length; i++) {
        processNode(node.children[i], currentContext);
      }
    }
    
    // Helper to get unique selector
    function getCssPath(el) {
      if (!(el instanceof Element)) return;
      const path = [];
      while (el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += '#' + el.id;
          path.unshift(selector);
          break;
        } else {
          let sib = el, nth = 1;
          while (sib = sib.previousElementSibling) {
            if (sib.nodeName.toLowerCase() == selector)
              nth++;
          }
          if (nth != 1)
            selector += ":nth-of-type("+nth+")";
        }
        path.unshift(selector);
        el = el.parentNode;
      }
      return path.join(" > ");
    }

    processNode(document.body);
    return elements.slice(0, 500); // Limit to ~500 elements to keep token count reasonable
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "scan-page") {
      console.log('CAST: Received scan-page message, depth:', msg.depth || 0);
      interactAndScan(msg.depth || 0);
      sendResponse({ success: true }); // Acknowledge receipt
      return true; // Keep channel open for async response
    }
    
    if (msg.type === "get-page-structure") {
        const dom = getSimplifiedDOM();
        sendResponse({ dom });
        return false;
    }
    
    if (msg.type === "show-highlight") {
        // Clear existing first
        document.querySelectorAll('.cast-strategy-overlay').forEach(el => el.remove());
        highlightElement(msg.selector, msg.label);
        sendResponse({ success: true });
        return false;
    }
    
    if (msg.type === "show-highlight-batch") {
        highlightBatch(msg.highlights);
        sendResponse({ success: true });
        return false;
    }
  });
  
  // Log that content script is loaded
  console.log('CAST: Content script loaded and ready');
})();
