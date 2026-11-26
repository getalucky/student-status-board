<template>
  <header class="app-header">
    <div class="header-inner">
      <RouterLink to="/" class="brand" aria-label="学生状态看板首页">
        <span class="brand-mark" aria-hidden="true">
          <span class="brand-mark-line" />
          <span class="brand-mark-line" />
          <span class="brand-mark-line" />
        </span>
        <span class="brand-text">
          <strong>学生状态看板</strong>
          <small>课后反馈助手</small>
        </span>
      </RouterLink>

      <nav class="header-nav" aria-label="主导航">
        <RouterLink to="/" class="nav-link" exact-active-class="is-active">看板</RouterLink>
        <RouterLink to="/settings" class="nav-link" active-class="is-active">设置</RouterLink>
      </nav>

      <div class="header-user">
        <span class="user-badge" aria-hidden="true">师</span>
        <span class="user-name">{{ auth.user?.name || '老师' }}</span>
        <el-button text class="logout-btn" :icon="SwitchButton" @click="handleLogout">
          <span class="logout-text">退出</span>
        </el-button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { SwitchButton } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useStudentsStore } from '@/stores/students'

const router = useRouter()
const auth = useAuthStore()
const students = useStudentsStore()

async function handleLogout() {
  try {
    await ElMessageBox.confirm('退出后需要重新输入密码登录。', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  await auth.logout()
  students.reset()
  ElMessage.success('已退出登录')
  await router.push('/login')
}
</script>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  height: var(--header-height);
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid var(--color-border);
  backdrop-filter: blur(10px);
}

.header-inner {
  max-width: var(--content-max);
  height: 100%;
  margin: 0 auto;
  padding: 0 var(--space-6);
  display: flex;
  align-items: center;
  gap: var(--space-8);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
  min-height: 44px;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--color-primary-600);
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  padding: 0 8px;
  box-shadow: var(--shadow-xs);
}

.brand-mark-line {
  display: block;
  height: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.92);
}

.brand-mark-line:nth-child(1) {
  width: 12px;
}

.brand-mark-line:nth-child(2) {
  width: 17px;
}

.brand-mark-line:nth-child(3) {
  width: 9px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text);
}

.brand-text small {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  letter-spacing: 0.06em;
}

.header-nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.nav-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--text-base);
  font-weight: 500;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.nav-link:hover {
  color: var(--color-text);
  background: var(--color-surface-soft);
}

.nav-link.is-active {
  color: var(--color-primary-700);
  background: var(--color-primary-50);
}

.nav-link.is-active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 4px;
  width: 16px;
  height: 2px;
  border-radius: 2px;
  background: var(--color-primary-500);
  transform: translateX(-50%);
}

.header-user {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.user-badge {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--color-primary-100);
  color: var(--color-primary-800);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: 600;
}

.user-name {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  color: var(--color-text-secondary);
}

@media (max-width: 767px) {
  .header-inner {
    padding: 0 var(--space-4);
    gap: var(--space-2);
  }

  .brand-mark {
    width: 32px;
    height: 32px;
  }

  .brand-text small,
  .user-badge,
  .user-name,
  .logout-text {
    display: none;
  }

  .header-nav {
    margin-left: auto;
  }

  .nav-link {
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
  }

  .header-user {
    margin-left: 0;
  }

  .logout-btn {
    width: 40px;
    padding: 0;
  }
}
</style>
