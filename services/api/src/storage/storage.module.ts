import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: StorageService,
      useFactory: () =>
        new StorageService({
          endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
          accessKey: process.env.S3_ACCESS_KEY ?? 'ventia',
          secretKey: process.env.S3_SECRET_KEY ?? 'ventia-secret',
          bucket: process.env.S3_BUCKET ?? 'ventia',
          publicUrl: process.env.S3_PUBLIC_URL ?? 'http://localhost:9000/ventia',
        }),
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
