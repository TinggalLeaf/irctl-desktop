import { createRouter, createWebHashHistory } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** 菜单/页头中文名 */
    title: string;
    /** Element Plus 图标组件名（全局注册） */
    icon: string;
    /** 需要硬件连接才可用 */
    needHw?: boolean;
  }
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    {
      path: '/dashboard',
      component: () => import('../views/DashboardView.vue'),
      meta: { title: '仪表盘', icon: 'Odometer' },
    },
    {
      path: '/receive',
      component: () => import('../views/ReceiveView.vue'),
      meta: { title: '接收学习', icon: 'Download', needHw: true },
    },
    {
      path: '/transmit',
      component: () => import('../views/TransmitView.vue'),
      meta: { title: '发射控制', icon: 'Promotion', needHw: true },
    },
    {
      path: '/library',
      component: () => import('../views/LibraryView.vue'),
      meta: { title: '码库', icon: 'Collection' },
    },
    {
      path: '/convert',
      component: () => import('../views/ConvertView.vue'),
      meta: { title: '格式转换', icon: 'Switch' },
    },
    {
      path: '/ai',
      component: () => import('../views/AiView.vue'),
      meta: { title: 'AI 助手', icon: 'MagicStick' },
    },
    {
      path: '/voice',
      component: () => import('../views/VoiceView.vue'),
      meta: { title: '语音控制', icon: 'Microphone' },
    },
    {
      path: '/settings',
      component: () => import('../views/SettingsView.vue'),
      meta: { title: '设置', icon: 'Setting' },
    },
  ],
});

export default router;
