import { ref, watch, computed, Ref } from 'vue';

export interface UseControllableStateProps<T> {
  prop: Ref<T | undefined>;
  defaultProp: T;
  emit: (event: 'update:modelValue' | any, ...args: any[]) => void;
  name?: string; // e.g., 'modelValue' or 'checked'
}

export function useControllableState<T>(props: UseControllableStateProps<T>) {
  const { prop, defaultProp, emit, name = 'modelValue' } = props;
  
  const isControlled = computed(() => prop.value !== undefined);
  const internalValue = ref<T>(defaultProp) as Ref<T>;

  const value = computed({
    get() {
      return isControlled.value ? prop.value! : internalValue.value;
    },
    set(val: T) {
      if (isControlled.value) {
        emit(`update:${name}`, val);
      } else {
        internalValue.value = val;
        emit(`update:${name}`, val); // Still emit for listeners
      }
    }
  });

  return value;
}
