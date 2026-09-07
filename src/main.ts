import './styles/themes.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { AdbClient } from './core/adb';
import { initTheme } from './ui/theme';
import { initConnect } from './ui/connect';
import { initShell } from './ui/shell';
import { initFiles } from './ui/files';
import { initPaneResizers } from './ui/layout';

const client = new AdbClient();

initPaneResizers();
initTheme();
initConnect(client);
initShell(client);
initFiles(client);
