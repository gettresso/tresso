import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/views/AppShell.vue'
import MailView from '@/views/MailView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // Every screen of the signed-in app sits next to the sidebar, which stays put while the screen changes.
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'unified', component: MailView },
        { path: 'inbox/:threadId', name: 'unified-thread', component: MailView },
        // Where notifications lead (mailNotificationPath): the conversation, in the Unified Inbox.
        { path: 'thread/:threadId', redirect: (to) => ({ name: 'unified-thread', params: { threadId: to.params.threadId } }) },
        { path: 'accounts/:accountId', name: 'account', component: MailView },
        { path: 'accounts/:accountId/:threadId', name: 'account-thread', component: MailView },
        { path: 'smart/:smartInboxId', name: 'smart-inbox', component: MailView },
        { path: 'smart/:smartInboxId/manage', name: 'smart-inbox-manage', component: MailView },
        { path: 'smart/:smartInboxId/:threadId', name: 'smart-inbox-thread', component: MailView },
        { path: 'batches', name: 'batches', component: MailView },
        { path: 'batches/:threadId', name: 'batches-thread', component: MailView },
        { path: 'cleanup', name: 'cleanup', component: MailView },
        { path: 'triage', name: 'triage', component: () => import('@/views/TriageView.vue'), meta: { requiresAuth: true } },
        { path: 'search', name: 'search', component: () => import('@/views/SearchView.vue'), meta: { requiresAuth: true } },
        { path: 'todos', name: 'todos', component: () => import('@/views/TodosView.vue'), meta: { requiresAuth: true } },
        { path: 'todos/:todoId', name: 'todo', component: () => import('@/views/TodosView.vue'), meta: { requiresAuth: true } },
        { path: 'brief', name: 'brief', component: () => import('@/views/DailyBriefView.vue'), meta: { requiresAuth: true } },
        { path: 'brief/:briefId', name: 'brief-edition', component: () => import('@/views/DailyBriefView.vue'), meta: { requiresAuth: true } },
        { path: 'calendar/:view(day|week|month|agenda)?/:date(\\d{4}-\\d{2}-\\d{2})?', name: 'calendar', component: () => import('@/views/CalendarView.vue'), meta: { requiresAuth: true } },
        { path: 'drafts', name: 'drafts', component: () => import('@/views/DraftsView.vue'), meta: { requiresAuth: true } },
        { path: 'outbox', name: 'outbox', component: () => import('@/views/OutboxView.vue'), meta: { requiresAuth: true } },
        { path: 'waiting', name: 'waiting', component: () => import('@/views/WaitingOnView.vue'), meta: { requiresAuth: true } },
        {
          path: 'settings',
          component: () => import('@/views/SettingsLayout.vue'),
          meta: { requiresAuth: true },
          children: [
            { path: '', redirect: { name: 'settings-accounts' } },
            { path: 'accounts', name: 'settings-accounts', component: () => import('@/views/SettingsAccountsView.vue') },
            { path: 'accounts/new', name: 'settings-accounts-new', component: () => import('@/views/AddAccountView.vue') },
            { path: 'signatures', name: 'settings-signatures', component: () => import('@/views/SettingsSignaturesView.vue') },
            { path: 'brief', name: 'settings-brief', component: () => import('@/views/SettingsBriefView.vue') },
            { path: 'calendar', name: 'settings-calendar', component: () => import('@/views/SettingsCalendarView.vue') },
            { path: 'smart-inboxes', name: 'settings-smart-inboxes', component: () => import('@/views/SettingsSmartInboxesView.vue') },
            { path: 'smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: () => import('@/views/SettingsSmartInboxEditView.vue') },
            { path: 'notifications', name: 'settings-notifications', component: () => import('@/views/SettingsNotificationsView.vue') },
            { path: 'batches', name: 'settings-batches', component: () => import('@/views/SettingsBatchesView.vue') },
          ],
        },
      ],
    },
    { path: '/auth/callback', name: 'auth-callback', component: () => import('@/views/AuthCallbackView.vue') },
  ],
})

// Signed-out visitors land on the sign-in screen.
router.beforeEach((to) => {
  if (to.matched.some((record) => record.meta.requiresAuth) && !useAuthStore().isAuthenticated) {
    return { name: 'unified' }
  }
  return true
})

export default router
