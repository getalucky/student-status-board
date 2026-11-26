<template>
  <el-dialog
    v-model="visible"
    :title="student ? '编辑学生' : '新建学生'"
    width="460px"
    align-center
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    class="student-form-dialog"
    @closed="handleClosed"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
      <el-form-item label="姓名" prop="name">
        <el-input
          v-model="form.name"
          maxlength="40"
          show-word-limit
          placeholder="学生姓名"
          autocomplete="off"
          :disabled="saving"
          @keydown.enter.prevent="submit"
        />
      </el-form-item>
      <el-form-item label="学校" prop="school">
        <el-input
          v-model="form.school"
          maxlength="60"
          placeholder="选填"
          autocomplete="off"
          :disabled="saving"
          @keydown.enter.prevent="submit"
        />
      </el-form-item>
      <el-form-item label="上课星期" prop="weekday">
        <el-select
          v-model="form.weekday"
          placeholder="选择星期"
          style="width: 100%"
          :disabled="saving"
          :teleported="false"
        >
          <el-option v-for="day in WEEKDAYS" :key="day.value" :label="day.label" :value="day.value" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="dialog-footer">
        <el-button :disabled="saving" @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">
          {{ student ? '保存修改' : '创建学生' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { WEEKDAYS } from '@/lib/tags'
import { errorMessage } from '@/lib/api'
import { useStudentsStore } from '@/stores/students'
import type { Student, Weekday } from '@/types'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    student?: Student | null
    defaultWeekday?: Weekday
  }>(),
  {
    student: null,
    defaultWeekday: 1,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [student: Student | null]
}>()

const store = useStudentsStore()
const formRef = ref<FormInstance>()
const saving = ref(false)

const form = reactive<{ name: string; school: string; weekday: Weekday }>({
  name: '',
  school: '',
  weekday: 1,
})

const rules: FormRules = {
  name: [
    { required: true, message: '请填写学生姓名', trigger: 'blur' },
    { whitespace: true, message: '姓名不能为空', trigger: 'blur' },
  ],
}

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    if (props.student) {
      form.name = props.student.name
      form.school = props.student.school ?? ''
      form.weekday = props.student.weekday
    } else {
      form.name = ''
      form.school = ''
      form.weekday = props.defaultWeekday
    }
    void nextTick(() => formRef.value?.clearValidate())
  },
  { immediate: true },
)

async function submit() {
  if (saving.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload = {
    name: form.name.trim(),
    school: form.school.trim() || null,
    weekday: form.weekday,
  }
  if (!payload.name) {
    ElMessage.warning('请填写学生姓名')
    return
  }

  saving.value = true
  try {
    let result: Student | null
    if (props.student) {
      result = await store.update(props.student.id, payload)
      ElMessage.success('学生信息已更新')
    } else {
      result = await store.create(payload)
      ElMessage.success('学生已创建')
    }
    emit('saved', result)
    visible.value = false
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    saving.value = false
  }
}

function handleClosed() {
  formRef.value?.clearValidate()
}
</script>

<style>
.student-form-dialog {
  max-width: calc(100vw - 32px);
}
</style>
