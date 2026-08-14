const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdfDialog: () => ipcRenderer.invoke('open-pdf-dialog'),
  readPdfFiles: (filePaths) => ipcRenderer.invoke('read-pdf-files', filePaths),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onTriggerOpenDialog: (callback) => ipcRenderer.on('trigger-open-dialog', callback),
  // Strips the raw ipcRenderer event before handing off — the isolated
  // world's callback only ever needs the action name itself.
  onTriggerEditAction: (callback) => ipcRenderer.on('trigger-edit-action', (event, action) => callback(action)),
  showPageContextMenu: () => ipcRenderer.invoke('show-page-context-menu'),
  showDocumentContextMenu: (scope) => ipcRenderer.invoke('show-document-context-menu', { scope }),
  saveDocuments: (payload) => ipcRenderer.invoke('save-documents', payload),
  deleteDocumentFile: (filePath) => ipcRenderer.invoke('delete-document-file', filePath),
  confirmCloseWithUnsavedChanges: (displayName) =>
    ipcRenderer.invoke('confirm-close-with-unsaved-changes', displayName),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  log: (level, message) => ipcRenderer.send('log', { level, message }),
});
