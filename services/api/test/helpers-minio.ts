import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export async function startMinio(): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const container: StartedTestContainer = await new GenericContainer('minio/minio')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'ventia', MINIO_ROOT_PASSWORD: 'ventia-secret' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  return { endpoint, stop: () => container.stop().then(() => undefined) };
}
