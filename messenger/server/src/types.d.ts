// Типы JWT-полезной нагрузки мессенджера для @fastify/jwt.
import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // payload — то, что подписываем; user — то, что читаем после jwtVerify().
    payload: { sub: string; orgId: string; email: string; kind: string };
    user: { sub: string; orgId: string; email: string; kind: string };
  }
}
