import { startApp } from '../app/bootstrap';
import { createEmbeddedPlatform } from '../platform/embedded';

void startApp(createEmbeddedPlatform());
