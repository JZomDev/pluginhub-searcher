package com.acoldoneclogging;

import com.acoldoneclogging.Overlays.LeoSpinOverlay;
import com.acoldoneclogging.Overlays.WideLeoOverlay;
import com.google.inject.Provides;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.*;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.ProjectileMoved;
import net.runelite.api.events.VarbitChanged;
import net.runelite.client.chat.ChatColorType;
import net.runelite.client.chat.ChatMessageBuilder;
import net.runelite.client.chat.ChatMessageManager;
import net.runelite.client.chat.QueuedMessage;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.DrawManager;
import net.runelite.client.ui.overlay.OverlayManager;
import net.runelite.client.util.Text;
import okhttp3.*;

import javax.imageio.ImageIO;
import javax.inject.Inject;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import static net.runelite.http.api.RuneLiteAPI.GSON;

@Slf4j
@PluginDescriptor(name = "AColdOne Clogging")
public class AColdOneCloggingPlugin extends Plugin {
    @Inject
    private Client client;

    @Inject
    private AColdOneCloggingConfig config;
    @Inject
    private SoundEngine soundEngine;
    @Inject
    private ChatMessageManager chatMessageManager;
    @Inject
    private ScheduledExecutorService executorService;
    @Inject
    private OverlayManager overlayManager;
    @Inject
    private DrawManager drawManager;
    @Inject
    private OkHttpClient okHttpClient;

    private final WideLeoOverlay wideLeoOverlay = new WideLeoOverlay();
    private final LeoSpinOverlay leoSpinOverlay = new LeoSpinOverlay();
    private static final Pattern clogRegex = Pattern.compile("New item added to your collection log:.*");
    private static final Pattern taskRegex = Pattern.compile("Congratulations, you've completed an? (?:\\w+) combat task:.*");
    private static final Set<Integer> badClogSettings = new HashSet<>() {{
        add(0);
        add(2);
    }};

    private int lastClogWarning = -1;

    private int lastBalledTick = -1;
    private boolean functionRunning = false;
    private final String[] wideLeoIcons = new String[59];
    private final String[] leoSpinIcons = new String[66];
	private final Random random = new Random();


    @Override
    protected void startUp() throws Exception {
        overlaysSetup();
    }

    @Override
    protected void shutDown() throws Exception {
        soundEngine.close();
    }

    @Subscribe
    protected void onGameStateChanged(GameStateChanged stateChanged) {
        switch (stateChanged.getGameState()) {
            case LOGIN_SCREEN:
            case LOGGING_IN:
            case HOPPING:
            case CONNECTION_LOST:
                lastClogWarning = client.getTickCount();
                break;
            case LOGGED_IN:
                break;
        }
    }

    @Subscribe
    public void onChatMessage(ChatMessage chatMessage) {
        if (chatMessage.getType() == ChatMessageType.PUBLICCHAT) {
            String Message = chatMessage.getMessage();
            boolean isUser = Text.sanitize(chatMessage.getName()).equalsIgnoreCase(client.getLocalPlayer().getName());
            if (config.WideLeo() && Message.equalsIgnoreCase("!Leo") && isUser) {
                overlayManager.add(wideLeoOverlay);
                LeoWiden();
            } else if (config.LeoSpin() && Message.equalsIgnoreCase("!LeoSpin") && isUser) {
                overlayManager.add(leoSpinOverlay);
                leoSpin();
            }

        }
        else if (chatMessage.getType() == ChatMessageType.GAMEMESSAGE) {
            String Message = chatMessage.getMessage();
            if (config.AnnounceClog() && clogRegex.matcher(Message).matches()) {
                Sound selectedLog = Sound.valueOf("CollectionLog_" + (random.nextInt(14) + 1));
                soundEngine.playClip(selectedLog);
            } else if (config.AnnounceCombatTasks() && taskRegex.matcher(Message).matches()) {
				Sound selectedLog = Sound.valueOf("TaskCompletion_" + (random.nextInt(3) + 1));
				soundEngine.playClip(selectedLog);
            }
        }
    }

    private void WarnForClogSettings(int newVarbitValue) {
        if (badClogSettings.contains(newVarbitValue)) {
            if (lastClogWarning == -1 || client.getTickCount() - lastClogWarning > 10) {
                lastClogWarning = client.getTickCount();
                SendMessage("Please enable \"Collection log - New addition notification\" in your game settings or switch off the \"AColdOne Clogging\" plugin to switch off this warning");
            }
        }
    }

    @Subscribe
    public void onVarbitChanged(VarbitChanged varbitChanged) {
        if (varbitChanged.getVarbitId() == Varbits.COLLECTION_LOG_NOTIFICATION) {
            WarnForClogSettings(varbitChanged.getValue());
        }
    }

    @Subscribe
    public void onProjectileMoved(ProjectileMoved projectileMoved) {
        int currentTick = client.getTickCount();
        if (currentTick - lastBalledTick > 500) {
            functionRunning = false;
        }
        if (functionRunning) {
            return;
        }
        Projectile projectile = projectileMoved.getProjectile();
        if (projectile.getId() != 55) {
            return;
        }
        Actor me = client.getLocalPlayer();
        if (me == null) {
            return;
        }
        Actor projectileInteraction = projectile.getInteracting();
        if (!me.equals(projectileInteraction)) {
            return;
        }
        if (!config.Balled()) {
            return;
        }
        functionRunning = true;
        lastBalledTick = currentTick;
        me.setOverheadText("Oh no, i got balled");
        executorService.schedule(() -> {
            soundEngine.playClip(Sound.valueOf("Balled_1"));
            if (config.BalledScreenshot() && config.WebhookLink()!=null) {
                sendScreenshot(me.getName());
            }
            client.getLocalPlayer().setOverheadText("");
        }, 1200, TimeUnit.MILLISECONDS);
    }

    public void SendMessage(String Message) {
        String highlightedMessage = new ChatMessageBuilder().append(ChatColorType.HIGHLIGHT).append(Message).build();

        chatMessageManager.queue(QueuedMessage.builder().type(ChatMessageType.CONSOLE).runeLiteFormattedMessage(highlightedMessage).build());
    }

    public void LeoWiden() {
        final Timer timer = new Timer();
        long interval = 40;
        TimerTask task = new TimerTask() {
            int currentIndex = 0;

            @Override
            public void run() {
                if (currentIndex < wideLeoIcons.length) {
                    String image = wideLeoIcons[currentIndex];
                    wideLeoOverlay.setImage(image);
                    currentIndex++;
                } else {
                    timer.cancel();
                    executorService.schedule(() -> {
                        overlayManager.remove(wideLeoOverlay);
                    }, 250, TimeUnit.MILLISECONDS);
                }
            }
        };
        timer.scheduleAtFixedRate(task, 0, interval);
    }

    public void leoSpin() {
        final Timer timer = new Timer();
        long interval = 40;

        TimerTask task = new TimerTask() {
            int currentIndex = 0;

            @Override
            public void run() {
                if (currentIndex < leoSpinIcons.length * config.LoopAmount()) {
                    String image = leoSpinIcons[currentIndex % leoSpinIcons.length];
                    leoSpinOverlay.setImage(image);
                    currentIndex++;
                } else {
                    timer.cancel();
                    executorService.schedule(() -> {
                        overlayManager.remove(leoSpinOverlay);
                    }, 250, TimeUnit.MILLISECONDS);
                }
            }
        };
        timer.scheduleAtFixedRate(task, 0, interval);
    }

    public void overlaysSetup() {
        for (int i = 0; i < 59; i++) {
            wideLeoIcons[i] = "/WideLeo/" + i + ".gif";
        }
        for(int i = 0; i < 66; i++){
            leoSpinIcons[i] = "/LeoSpin/" + i + ".gif";
        }
    }


    private void sendScreenshot(String playerName)
    {
        String MessageString;
        MessageString = String.format("%s %s", playerName, "got balled <:x0r6ztlurk:948329913734275093>");
        DiscordWebhookBody discordWebhookBody = new DiscordWebhookBody();
        discordWebhookBody.setContent(MessageString);

        String webhookLink = config.WebhookLink();
        HttpUrl url = HttpUrl.parse(webhookLink);
        MultipartBody.Builder requestBodyBuilder = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("payload_json", GSON.toJson(discordWebhookBody));

        drawManager.requestNextFrameListener(image ->
        {
            BufferedImage bufferedImage = (BufferedImage) image;
            byte[] imageBytes;
            try
            {
                imageBytes = convertImageToByteArray(bufferedImage);
            }
            catch (IOException e)
            {
                log.warn("Error converting image to byte array", e);
                return;
            }

            requestBodyBuilder.addFormDataPart("file", "image.png",
                    RequestBody.create(MediaType.parse("image/png"), imageBytes));
            buildRequestAndSend(url, requestBodyBuilder);
        });
    }


    private void buildRequestAndSend(HttpUrl url, MultipartBody.Builder requestBodyBuilder)
    {
        RequestBody requestBody = requestBodyBuilder.build();
        Request request = new Request.Builder()
                .url(url)
                .post(requestBody)
                .build();

        okHttpClient.newCall(request).enqueue(new Callback()
        {
            @Override
            public void onFailure(Call call, IOException e)
            {
                log.debug("Error submitting webhook", e);
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException
            {
                response.close();
            }
        });
    }

    private static byte[] convertImageToByteArray(BufferedImage bufferedImage) throws IOException
    {
        ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream();
        ImageIO.write(bufferedImage, "png", byteArrayOutputStream);
        return byteArrayOutputStream.toByteArray();
    }
    @Provides
    AColdOneCloggingConfig provideConfig(ConfigManager configManager) {
        return configManager.getConfig(AColdOneCloggingConfig.class);
    }
}
