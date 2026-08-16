"use strict";
function openSidePanel() {
  chrome.sidePanel.setOptions({ path: "index.html" })
    .then(() => chrome.windows.getCurrent())
    .then(win => chrome.sidePanel.open({ windowId: win.id }))
    .catch(() => {
      try { chrome.sidePanel.open().then(() => { }, () => { }); } catch (e) { }
    });
}
chrome.action.onClicked.addListener(openSidePanel);
