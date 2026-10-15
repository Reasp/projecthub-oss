import { startApp } from '../app/bootstrap';
import { createCapacitorPlatform } from '../platform/capacitor';

void startApp(createCapacitorPlatform());
