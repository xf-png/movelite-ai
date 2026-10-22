import { solvePlans } from './engine.js';

self.onmessage = ({ data }) => {
  if (data?.type !== 'solve') return;
  const { requestId, items, settings } = data;
  try {
    self.postMessage({ type: 'result', requestId, result: solvePlans(items, settings) });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error?.message || '方案计算失败，请检查物品与设置后重试。' });
  }
};
