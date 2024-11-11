package com.acoldoneclogging.Overlays;

import com.acoldoneclogging.AColdOneCloggingPlugin;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.util.ImageUtil;

import javax.inject.Inject;
import java.awt.*;
import java.awt.image.BufferedImage;

public class WideLeoOverlay extends OverlayPanel {
    @Inject
    private BufferedImage bufferedImage;
    private AlphaComposite alphaComposite = AlphaComposite.getInstance(AlphaComposite.SRC_OVER);
    public WideLeoOverlay() {
        bufferedImage = ImageUtil.loadImageResource(WideLeoOverlay.class, "/WideLeo/0.gif");
        setPosition(OverlayPosition.DYNAMIC);
    }
    @Override
    public Dimension render(Graphics2D graphics) {
        graphics.setComposite(alphaComposite);
        graphics.drawImage(bufferedImage.getScaledInstance(336, 112, Image.SCALE_SMOOTH), 100, 100, null);
        return null;
    }
    public void setImage(String image) {
        bufferedImage = ImageUtil.loadImageResource(AColdOneCloggingPlugin.class, image);
    }
}