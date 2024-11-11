package com.acoldoneclogging.Overlays;

import com.acoldoneclogging.AColdOneCloggingPlugin;
import net.runelite.api.Client;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.util.ImageUtil;

import javax.inject.Inject;
import java.awt.*;
import java.awt.image.BufferedImage;

public class LeoSpinOverlay extends OverlayPanel {
    @Inject
    private Client client;
    private BufferedImage bufferedImage;
    public LeoSpinOverlay(){
        bufferedImage = ImageUtil.loadImageResource(LeoSpinOverlay.class,"/LeoSpin/0.gif");
        setPosition(OverlayPosition.DYNAMIC);
    }
    @Override
    public Dimension render(Graphics2D graphics){
        AlphaComposite alphaComposite = AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 1);
        graphics.setComposite(alphaComposite);
        graphics.drawImage(bufferedImage.getScaledInstance(128, 128, Image.SCALE_SMOOTH), 100, 100, null);
        return null;
    }
    public void setImage(String image){
        bufferedImage = ImageUtil.loadImageResource(AColdOneCloggingPlugin.class, image);
    }
}
