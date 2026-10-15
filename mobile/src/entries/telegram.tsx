import { startApp } from '../app/bootstrap';
import { createTelegramPlatform } from '../platform/telegram';

void startApp(createTelegramPlatform());
