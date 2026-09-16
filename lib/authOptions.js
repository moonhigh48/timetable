import GoogleProvider from "next-auth/providers/google";

// 필수 환경변수 (Vercel Project Settings → Environment Variables):
// - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (Google Cloud Console OAuth 클라이언트)
// - NEXTAUTH_SECRET                          (아무 랜덤 문자열, `openssl rand -base64 32`로 생성 가능)
// - NEXTAUTH_URL                             (배포 도메인, 예: https://timetable-mu-six.vercel.app)
//
// 이름이 위와 다르게 Vercel에 등록돼 있다면 아래 process.env.XXX 부분을 그 이름으로 맞춰주세요.

export const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/tasks",
          ].join(" "),
          access_type: "offline", // refresh token 발급용
          prompt: "consent",      // 매번 동의 화면을 띄워 refresh token을 확실히 받음
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    // 로그인 시 Google이 준 accessToken을 JWT에 저장
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.accessTokenExpires = account.expires_at ? account.expires_at * 1000 : undefined;
      }
      return token;
    },
    // 클라이언트(useSession)에서 session.accessToken으로 꺼내 쓸 수 있게 노출
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      return session;
    },
  },
};
