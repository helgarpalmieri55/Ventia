import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { LaunchController } from './launch.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [AdminModule],
  controllers: [OnboardingController, LaunchController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
