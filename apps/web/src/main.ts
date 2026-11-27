import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './theme';
import './styles/main.css';

const app = createApp(App);

app.use(router);
app.use(ElementPlus);

void router.isReady().then(() => app.mount('#app'));
