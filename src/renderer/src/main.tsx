import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './styles/index.css';

// Electron/Chromium 默认：拖文件到窗口任意处会导航到 file://，且未在
// document 级 preventDefault dragover 时，子元素的 drop 事件可能不稳定触发。
// 全局吞掉窗口级默认拖放（放行到具体投放区由各元素自己 preventDefault +
// stopPropagation 处理），这是 Electron 文件拖放能可靠工作的前提。
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(
    type,
    (e) => {
      // 未被具体投放区消费（stopPropagation）的拖放 → 阻止默认导航行为。
      e.preventDefault();
    },
    false,
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
