import { defineComponent, h, provide, inject, ref, watchEffect, Ref } from 'vue';
import { createAvatar, AvatarStatus } from '@uifn/core/primitives/avatar';

const AvatarSymbol = Symbol('Avatar');

export const Avatar = defineComponent({
  name: 'Avatar',
  setup(_, { slots }) {
    const machine = createAvatar();
    const status = ref<AvatarStatus>(machine.state.status);

    machine.subscribe((newState) => {
      status.value = newState.status;
    });

    provide(AvatarSymbol, {
      status,
      actions: machine.actions
    });

    return () => h('span', {
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle', overflow: 'hidden', borderRadius: '100%', backgroundColor: '#eee', width: '40px', height: '40px' }
    }, slots.default?.());
  }
});

export const AvatarImage = defineComponent({
  name: 'AvatarImage',
  props: {
    src: String,
    alt: String
  },
  setup(props, { attrs }) {
    const context = inject<{ status: Ref<AvatarStatus>, actions: any }>(AvatarSymbol);
    if (!context) throw new Error('AvatarImage must be used within Avatar');

    watchEffect(() => {
        if (!props.src) {
            context.actions.setError();
            return;
        }
        
        context.actions.setLoading();
        const img = new Image();
        img.src = props.src;
        img.onload = () => context.actions.setLoaded();
        img.onerror = () => context.actions.setError();
    });

    return () => {
        if (context.status.value === 'loaded') {
            return h('img', {
                src: props.src,
                alt: props.alt,
                style: { width: '100%', height: '100%', objectFit: 'cover' },
                ...attrs
            });
        }
        return null;
    };
  }
});

export const AvatarFallback = defineComponent({
  name: 'AvatarFallback',
  props: {
    delayMs: {
      type: Number,
      default: 0
    }
  },
  setup(props, { slots }) {
    const context = inject<{ status: Ref<AvatarStatus> }>(AvatarSymbol);
    if (!context) throw new Error('AvatarFallback must be used within Avatar');

    const canRender = ref(false);

    watchEffect((cleanup) => {
        if (context.status.value === 'loading') {
            if (props.delayMs > 0) {
                const timer = setTimeout(() => canRender.value = true, props.delayMs);
                cleanup(() => clearTimeout(timer));
            } else {
                canRender.value = true;
            }
        } else {
            canRender.value = context.status.value === 'error' || context.status.value === 'idle';
        }
    });

    return () => {
        if (canRender.value) {
            return h('span', {
                style: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }
            }, slots.default?.());
        }
        return null;
    };
  }
});
