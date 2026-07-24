import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { SettingsController } from './settings.controller';

@Module({
  imports: [AdminModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
