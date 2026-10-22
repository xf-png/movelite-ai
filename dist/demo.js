const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const todayISO = () => day(new Date());
export function daysFromToday(count) { const date = new Date(); date.setDate(date.getDate() + count); return day(date); }

export function createDemo(scene = 'graduation') {
  const raw = [
    ['work', '工作电脑与显示器', 'electronics', '书房', 160, 5, 0, 3000, 90, 20, 15, 0, 'good', 'keep', 1],
    ['memory', '证件与毕业相册', 'sentimental', '卧室', 40, 5, 3, 0, 30, 15, 10, 0, 'good', 'keep', 1],
    ['clothes', '四季衣物', 'clothing', '卧室', 240, 4, 1, 80, 45, 20, 10, 0, 'good', 'auto', 3],
    ['chair', '人体工学椅', 'furniture', '书房', 180, 4, 0, 480, 60, 20, 15, 0, 'good', 'auto', 1],
    ['sofa', '双人布艺沙发', 'furniture', '客厅', 900, 2, 1, 800, 120, 40, 30, 50, 'worn', 'auto', 1],
    ['fridge', '小冰箱', 'electronics', '厨房', 360, 3, 0, 300, 75, 30, 20, 30, 'good', 'auto', 1],
    ['books', '专业书与小说', 'books', '书房', 240, 3, 2, 120, 60, 20, 10, 0, 'good', 'auto', 4],
    ['camp', '露营全套装备', 'sports', '储物区', 280, 2, 1, 350, 75, 25, 15, 0, 'good', 'auto', 1],
    ['coffee', '咖啡机与磨豆机', 'kitchen', '厨房', 130, 4, 1, 600, 60, 15, 15, 0, 'good', 'auto', 1],
    ['rack', '落地衣架', 'furniture', '卧室', 120, 2, 0, 30, 30, 15, 10, 0, 'worn', 'auto', 1],
    ['rice', '备用电饭煲', 'kitchen', '厨房', 90, 1, 0, 80, 30, 15, 10, 0, 'good', 'auto', 1],
    ['cabinet', '破损收纳柜', 'furniture', '储物区', 300, 1, 0, 0, 60, 30, 20, 30, 'broken', 'auto', 1],
  ];
  const items = raw.map(([id, name, category, room, volumeL, priority, sentiment, resalePrice, saleMinutes, donateMinutes, recycleMinutes, recycleFee, condition, lock, quantity]) => ({
    id, name, category, room, quantity, volumeL, priority, sentiment, resalePrice, saleMinutes, donateMinutes, recycleMinutes, recycleFee, condition, lock,
    confirmed: true, origin: 'sample', notes: '虚构示例物品。体积、金额与耗时均为整组假设，可按你的情况修改。',
  }));
  return {
    items,
    settings: {
      capacityL: scene === 'smallhome' ? 1000 : 1800,
      timeMinutes: scene === 'urgent' ? 90 : scene === 'smallhome' ? 360 : 300,
      moveDate: daysFromToday(scene === 'urgent' ? 3 : scene === 'smallhome' ? 20 : 14),
      tiers: [{ id: 'small', name: '小型车', capacityL: 1000, price: 160 }, { id: 'medium', name: '中型车', capacityL: 2000, price: 260 }, { id: 'large', name: '大型车', capacityL: 4000, price: 450 }],
    },
    completed: {}, actualIncome: {},
  };
}
