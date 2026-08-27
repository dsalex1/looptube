import App from '@/App.vue'
import '@/style.css'
import { registerSW } from 'virtual:pwa-register'
import { createApp } from 'vue'

// installed copies update themselves; there is no state worth prompting about
registerSW({ immediate: true })

createApp(App).mount('#app')
