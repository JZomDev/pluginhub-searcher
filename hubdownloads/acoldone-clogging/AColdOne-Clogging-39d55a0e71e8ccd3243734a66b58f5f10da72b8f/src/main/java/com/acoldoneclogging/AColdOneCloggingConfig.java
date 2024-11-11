package com.acoldoneclogging;

import net.runelite.client.config.*;

@ConfigGroup("AColdOneClogging")
public interface AColdOneCloggingConfig extends Config
{
	@ConfigSection(
			name = "Leo",
			description = "Cause Leo and his emotes deserve their own section",
			position = 1
	)
	String Leo="Leo";
	@ConfigSection(
			name = "Misc Sounds",
			description = "Any Extra funny sounds that i may add",
			position = 2
	)
	String Misc="misc";
	@Range(
		min = 0,
		max = 10000
	)
	@ConfigItem(
		keyName = "Volume",
		name = "Volume",
		description = "Control how loud the audio should be"
	)
	default int Volume()
	{
		return 100;
	}
	@ConfigItem(
			keyName = "AnnounceClog",
			name = "Collection Logs",
			description = "Announces Collection Logs with an Audio Clip"
	)
	default boolean AnnounceClog(){
		return true;
	}
	@ConfigItem(
			keyName = "AnnounceCombatTasks",
			name = "Combat Achievements",
			description = "Announces Combat Task Completions with an Audio Clip"
	)
	default boolean AnnounceCombatTasks(){
		return true;
	}
	@ConfigItem(
			keyName = "Balled",
			name = "Getting Balled",
			description = "Get Balled Lmao",
			section = Misc
	)
	default boolean Balled()
	{
		return true;
	}
	@ConfigItem(
			keyName = "BalledScreenshot",
			name = "Screenshot of getting Balled",
			description = "Screenshot of you getting balled being shared in the #gatored-balled channel of the AColdOne Discord Server",
			section = Misc
	)
	default boolean BalledScreenshot()
	{
		return true;
	}

	@ConfigItem(
			keyName = "WebhookLink",
			name = "Discord Webhook Link",
			description = "Discord Webhook Link to send screenshot to",
			section = Misc
	)
	default String WebhookLink() { return "";}
	@ConfigItem(
			keyName = "WideLeo",
			name = "Wide Leo Emote",
			description = "Overlay the 7TV emote \"LeoWidenUp\" on the screen when saying \"!Leo\" ",
			position = 1,
			section = Leo
	)
	default boolean WideLeo()
	{
		return true;
	}
	@ConfigItem(
			keyName = "LeoSpin",
			name = "Leo Spin Emote",
			description = "Overlay the 7TV emote \"LeoSpin\" on the screen when saying \"!LeoSpin\" ",
			position = 2,
			section = Leo
	)
	default boolean LeoSpin()
	{
		return true;
	}
	@ConfigItem(
			keyName = "LoopAmount",
			name = "Loop Amount",
			description = "Number of times to loop the gif on the screen when saying \"!LeoSpin\" ",
			position = 3,
			section = Leo
	)
	default int LoopAmount()
	{
		return 3;
	}
}
