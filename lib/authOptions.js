import GoogleProvider from "next-auth/providers/google";


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
